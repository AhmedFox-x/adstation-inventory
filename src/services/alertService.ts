import { PrismaClient } from "@prisma/client";
import { checkAndSendAlerts, runManualAlertCheck } from "../utils/alerts";
import { upsertBroadcastNotification, NotificationCategory, NotificationSeverity } from "./notificationService";
import { runAnomalyDetection } from "./anomalyService";

// ─────────────────────────────────────────────────────────────────────────────
// فحص شامل بيتولّد منه إشعارات داخلية (Alerts Center) لكل الفئات:
// stock / reorder / pricing / returns / orders / quarantine / anomalies
// منع التكرار عبر sourceKey فريد لكل (فئة + كيان).
// ─────────────────────────────────────────────────────────────────────────────

type FeedItem = { type: string; entityId: string };

function sourceKey(category: string, entityId: string): string {
  return `sweep:${category}:${entityId}`;
}

async function feedNotification(
  db: PrismaClient,
  input: {
    category: NotificationCategory;
    severity: NotificationSeverity;
    type: string;
    title: string;
    message: string;
    entityType?: string;
    entityId?: string;
    referenceType?: string;
    referenceId?: string;
    actionUrl?: string;
  }
) {
  const key = sourceKey(String(input.category), input.entityId || input.referenceId || input.title);
  await upsertBroadcastNotification(db, {
    category: input.category,
    severity: input.severity,
    type: input.type,
    title: input.title,
    message: input.message,
    entityType: input.entityType,
    entityId: input.entityId,
    referenceType: input.referenceType,
    referenceId: input.referenceId,
    actionUrl: input.actionUrl,
    sourceKey: key,
    userId: null,
  });
}

export async function runAlertsSweep(db: PrismaClient): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  const add = (cat: string) => (counts[cat] = (counts[cat] || 0) + 1);

  // ── stock: مخزون تحت الحد الأدنى ───────────────────────────────────────────
  const lowStock = await db.product.findMany({
    where: { deletedAt: null, minStock: { gt: 0 } },
    select: { id: true, name: true, stock: true, minStock: true, sku: true, category: true },
  });
  for (const p of lowStock.filter((x) => x.stock <= x.minStock)) {
    await feedNotification(db, {
      category: "stock",
      severity: p.stock <= 0 ? "critical" : "high",
      type: "low_stock",
      title: p.stock <= 0 ? "منتج نَفد من المخزون" : "مخزون منخفض",
      message: `${p.name}: المتاح ${p.stock} (الحد الأدنى ${p.minStock})`,
      entityType: "product",
      entityId: p.id,
      actionUrl: `/products?focus=${p.id}`,
    });
    add("stock");
  }

  // ── reorder: نقطة إعادة الطلب ──────────────────────────────────────────────
  const toReorder = await db.product.findMany({
    where: { deletedAt: null, reorderPoint: { gt: 0 } },
    select: { id: true, name: true, stock: true, reorderPoint: true, sku: true },
  });
  for (const p of toReorder.filter((x) => x.stock <= x.reorderPoint)) {
    await feedNotification(db, {
      category: "reorder",
      severity: "normal",
      type: "reorder_needed",
      title: "وصل لنقطة إعادة الطلب",
      message: `${p.name}: المتاح ${p.stock} (نقطة إعادة الطلب ${p.reorderPoint})`,
      entityType: "product",
      entityId: p.id,
      actionUrl: `/products?focus=${p.id}`,
    });
    add("reorder");
  }

  // ── pricing: فروقات أسعار الشراء ≥ 20% ─────────────────────────────────────
  const variances = await db.inventoryLog.findMany({
    where: { type: "price_variance", createdAt: { gte: new Date(Date.now() - 7 * 86400000) } },
    include: { product: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  for (const v of variances) {
    const after = (v.afterData ?? {}) as any;
    const pct = Number(after?.variancePct) || 0;
    if (Math.abs(pct) >= 20) {
      await feedNotification(db, {
        category: "pricing",
        severity: Math.abs(pct) >= 40 ? "high" : "normal",
        type: "price_variance",
        title: "فارق سعر شراء كبير",
        message: `${v.product?.name || ""}: الفرق ${pct}% عن آخر تكلفة`,
        entityType: "product",
        entityId: v.productId,
        referenceType: "price_variance",
        referenceId: v.id,
        actionUrl: `/reports/price-variance`,
      });
      add("pricing");
    }
  }

  // ── returns: ردّ مالي متأخر / مرتجع معلّق ──────────────────────────────────
  const overdueRefunds = await db.returnOrder.findMany({
    where: { deletedAt: null, refundStatus: { in: ["pending", "partial"] }, refundDueAt: { lt: new Date() } },
    select: { id: true, returnNumber: true, refundDueAt: true, refundStatus: true },
    take: 100,
  });
  for (const r of overdueRefunds) {
    await feedNotification(db, {
      category: "returns",
      severity: "high",
      type: "return_refund_delayed",
      title: "ردّ مالي متأخر لمرتجع",
      message: `${r.returnNumber}: استحق بتاريخ ${r.refundDueAt?.toISOString().slice(0, 10)}`,
      entityType: "return_order",
      entityId: r.id,
      actionUrl: `/returns?focus=${r.id}`,
    });
    add("returns");
  }
  const pendingReturns = await db.returnOrder.findMany({
    where: { deletedAt: null, status: { in: ["received", "approved"] }, createdAt: { lt: new Date(Date.now() - 3 * 86400000) } },
    select: { id: true, returnNumber: true, status: true, createdAt: true },
    take: 100,
  });
  for (const r of pendingReturns) {
    await feedNotification(db, {
      category: "returns",
      severity: "normal",
      type: "return_created",
      title: "مرتجع معلّق بدون إجراء",
      message: `${r.returnNumber}: الحالة "${r.status}" منذ أكثر من 3 أيام`,
      entityType: "return_order",
      entityId: r.id,
      actionUrl: `/returns?focus=${r.id}`,
    });
    add("returns");
  }

  // ── orders: أوامر شراء متأخرة + اعتمادات بيع معلّقة ────────────────────────
  const latePOs = await db.purchaseOrder.findMany({
    where: { deletedAt: null, expectedDeliveryDate: { lt: new Date() }, status: { in: ["draft", "submitted", "approved", "sent"] } },
    select: { id: true, orderNumber: true, expectedDeliveryDate: true, status: true },
    take: 100,
  });
  for (const po of latePOs) {
    await feedNotification(db, {
      category: "orders",
      severity: "normal",
      type: "order_expired",
      title: "أمر شراء متأخر عن الموعد",
      message: `${po.orderNumber}: كان من المفترض وصوله ${po.expectedDeliveryDate?.toISOString().slice(0, 10)}`,
      entityType: "purchase_order",
      entityId: po.id,
      actionUrl: `/purchase-orders?focus=${po.id}`,
    });
    add("orders");
  }
  const pendingApprovals = await db.salesOrderApproval.findMany({
    where: { status: "pending", createdAt: { lt: new Date(Date.now() - 86400000) } },
    select: { id: true, salesOrderId: true, createdAt: true },
    take: 100,
  });
  for (const ap of pendingApprovals) {
    await feedNotification(db, {
      category: "orders",
      severity: "high",
      type: "approval_needed",
      title: "طلب اعتماد بيع متأخر",
      message: `أمر بيع بانتظار الاعتماد منذ ${ap.createdAt?.toISOString().slice(0, 10)}`,
      entityType: "sales_order",
      entityId: ap.salesOrderId,
      actionUrl: `/sales-orders?focus=${ap.salesOrderId}`,
    });
    add("orders");
  }

  // ── quarantine: بضاعة في الحجر الصحي ───────────────────────────────────────
  const quarantined = await db.product.findMany({
    where: { deletedAt: null, quarantineStock: { gt: 0 } },
    select: { id: true, name: true, quarantineStock: true },
    take: 200,
  });
  for (const p of quarantined) {
    await feedNotification(db, {
      category: "quarantine",
      severity: "normal",
      type: "quarantine",
      title: "بضاعة في الحجر الصحي",
      message: `${p.name}: ${p.quarantineStock} قطعة لسه محجوزة`,
      entityType: "product",
      entityId: p.id,
      actionUrl: `/products?focus=${p.id}`,
    });
    add("quarantine");
  }

  // ── anomalies: تشغيل الكشف والإبلاغ عما يتولد ───────────────────────────────
  const anomalyResult = await runAnomalyDetection(db);
  if (anomalyResult.detected > 0) {
    const severe = (anomalyResult.byRule["cost_price_spike"] || 0) + (anomalyResult.byRule["negative_stock"] || 0);
    await feedNotification(db, {
      category: "anomalies",
      severity: severe > 0 ? "critical" : "high",
      type: "anomaly_detected",
      title: "حالات شاذة جديدة في المخزون",
      message: `رصد كشفُ القواعد ${anomalyResult.detected} حالة جديدة (${Object.entries(anomalyResult.byRule).map(([k, v]) => `${k}: ${v}`).join("، ")})`,
      actionUrl: `/alerts-center?tab=anomalies`,
    });
    add("anomalies");
  }

  // ── إرسال إيميل low-stock كالمعتاد (غير مدمج في counts) ─────────────────────
  try {
    await runManualAlertCheck(db);
  } catch {
    // SMTP failure غير ماوقف السويب
  }

  return counts;
}

export async function alertsSummary(db: PrismaClient) {
  const [totalUnread, activeCounts, openAnomalies] = await Promise.all([
    db.notification.count({
      where: { createdBySystem: true, deletedAt: null, isRead: false, snoozedUntil: null },
    }),
    db.notification.groupBy({
      by: ["category"],
      where: { createdBySystem: true, deletedAt: null, resolvedAt: null, OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: new Date() } }] },
      _count: { _all: true },
    }),
    db.anomaly.count({ where: { status: { in: ["open", "reviewing"] } } }),
  ]);

  const grouped: Record<string, number> = {
    stock: 0, reorder: 0, pricing: 0, returns: 0, orders: 0, quarantine: 0, anomalies: 0,
  };
  for (const g of activeCounts) {
    if (g.category) grouped[g.category] = (grouped[g.category] || 0) + (g._count._all || 0);
  }
  return { unreadCount: totalUnread, byCategory: grouped, openAnomalies };
}