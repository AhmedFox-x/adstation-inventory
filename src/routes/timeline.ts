import { Router } from "express";
import { prisma } from "../config/database";
import { requireAuth, requirePermission } from "../middleware/auth";
import { PERMISSIONS } from "../utils/permissions";

const router = Router();

export interface TimelineEvent {
  ts: string;
  type: string; // status | log | cost | delivery | transfer | refund | created
  title: string;
  description: string;
  user?: string | null;
  refType?: string | null;
  refId?: string | null;
  severity?: string;
}

const CLEAN_TYPE: Record<string, string> = {
  withdraw: "صرف منتجات",
  supply: "توريد منتجات",
  manual_adjust: "تعديل يدوي",
  stocktake: "جرد",
  reconciliation: "تسوية",
  transfer_out: "تحويل خارجي",
  transfer_in: "تحويل وارد",
  purchase_receive: "استلام مشتريات",
  quarantine_in: "إيداع الحجر الصحي",
  price_variance: "فرق سعر شراء",
  reservation_fulfill: "تسليم حجز",
  reservation: "حجز مخزون",
};

function humanType(t: string): string {
  return CLEAN_TYPE[t] || t;
}

function rowsFromLogs(logs: any[]): TimelineEvent[] {
  return logs.map((l) => ({
    ts: l.createdAt.toISOString(),
    type: "log",
    title: humanType(l.type),
    description: `${l.product?.name || ""}: ${l.change > 0 ? "+" : ""}${l.change} (${l.oldStock} → ${l.newStock})${l.notes ? ` — ${l.notes}` : ""}`,
    user: l.userName || l.salesName || l.clientName || null,
    refType: l.referenceType,
    refId: l.referenceId,
  }));
}

// GET /timeline?entityType=&entityId=&limit=
router.get("/timeline", requireAuth, requirePermission(PERMISSIONS.TIMELINE_VIEW), async (req, res, next) => {
  try {
    const { entityType, entityId, limit = "200" } = req.query as Record<string, string>;
    if (!entityType || !entityId) {
      res.status(400).json({ error: "entityType and entityId are required" });
      return;
    }
    const take = Math.min(Number(limit) || 200, 500);
    const events: TimelineEvent[] = [];

    switch (entityType) {
      case "product": {
        const [logs, costs] = await Promise.all([
          prisma.inventoryLog.findMany({
            where: { productId: entityId },
            orderBy: { createdAt: "desc" },
            take,
            include: { product: { select: { name: true } } },
          }),
          prisma.costHistory.findMany({
            where: { productId: entityId },
            orderBy: { createdAt: "desc" },
            take: 100,
          }),
        ]);
        events.push(...rowsFromLogs(logs));
        events.push(
          ...costs.map((c) => ({
            ts: c.createdAt.toISOString(),
            type: "cost" as const,
            title: "تحديث تكلفة" + (c.reason === "first_purchase" ? " (أول شراء)" : c.reason === "adjustment" ? " (تعديل)" : ""),
            description: `${c.oldCost ?? "—"} → ${c.newCost ?? "—"} جنيه` + (c.purchasePrice ? ` (سعر شراء ${c.purchasePrice})` : ""),
            user: c.userName || null,
            refType: c.referenceType,
            refId: c.referenceId,
          }))
        );
        break;
      }

      case "sales_order": {
        const [history, deliveries] = await Promise.all([
          prisma.salesOrderStatusHistory.findMany({ where: { orderId: entityId }, orderBy: { createdAt: "desc" }, take }),
          prisma.salesDelivery.findMany({
            where: { salesOrderId: entityId },
            orderBy: { createdAt: "desc" },
            take: 50,
            include: { items: true },
          }),
        ]);
        events.push(
          ...history.map((h) => ({
            ts: h.createdAt.toISOString(),
            type: "status" as const,
            title: "تغيّر حالة أمر البيع",
            description: `${h.fromStatus || "—"} → ${h.toStatus}${h.note ? ` — ${h.note}` : ""}`,
            user: h.changedBy || null,
          }))
        );
        events.push(
          ...deliveries.map((d) => ({
            ts: d.createdAt.toISOString(),
            type: "delivery" as const,
            title: `توصيل ${d.deliveryNumber}`,
            description: `${(d.items || []).length} صنف${d.driverName ? ` — السائق: ${d.driverName}` : ""}${d.vehicle ? ` (${d.vehicle})` : ""}`,
            user: d.deliveredBy || null,
            refType: "delivery",
            refId: d.id,
          }))
        );
        break;
      }

      case "client": {
        const soHistory = await prisma.salesOrderStatusHistory.findMany({
          where: { order: { clientId: entityId } },
          orderBy: { createdAt: "desc" },
          take,
          include: { order: { select: { orderNumber: true } } },
        });
        for (const h of soHistory) {
          events.push({
            ts: h.createdAt.toISOString(),
            type: "status",
            title: `${h.order?.orderNumber || ""}: تغيّر حالة`,
            description: `${h.fromStatus || "—"} → ${h.toStatus}${h.note ? ` — ${h.note}` : ""}`,
            user: h.changedBy || null,
            refType: "sales_order",
            refId: h.orderId,
          });
        }
        const permits = await prisma.withdrawalPermit.findMany({
          where: { clientId: entityId, deletedAt: null },
          orderBy: { createdAt: "desc" },
          take: 100,
          include: { _count: { select: { items: true } } },
        });
        events.push(
          ...permits.map((p) => ({
            ts: p.createdAt.toISOString(),
            type: "status" as const,
            title: `تصريح صرف ${p.permitNumber}`,
            description: `${p._count.items} صنف — الحالة ${p.status}`,
            refType: "withdrawal_permit",
            refId: p.id,
          }))
        );
        const returns = await prisma.returnOrder.findMany({
          where: { partyId: entityId, deletedAt: null },
          orderBy: { createdAt: "desc" },
          take: 100,
        });
        events.push(
          ...returns.map((r) => ({
            ts: r.createdAt.toISOString(),
            type: "status" as const,
            title: `مرتجع ${r.returnNumber}`,
            description: `الحالة ${r.status}${r.refundStatus && r.refundStatus !== "none" ? ` — الردّ: ${r.refundStatus}` : ""}`,
            refType: "return_order",
            refId: r.id,
          }))
        );
        break;
      }

      case "supplier": {
        const poHistory = await prisma.purchaseOrderStatusHistory.findMany({
          where: { order: { supplierId: entityId } },
          orderBy: { createdAt: "desc" },
          take,
          include: { order: { select: { orderNumber: true } } },
        });
        for (const h of poHistory) {
          events.push({
            ts: h.createdAt.toISOString(),
            type: "status",
            title: `${h.order?.orderNumber || ""}: تغيّر حالة`,
            description: `${h.fromStatus || "—"} → ${h.toStatus}${h.note ? ` — ${h.note}` : ""}`,
            user: h.changedBy || null,
            refType: "purchase_order",
            refId: h.orderId,
          });
          void h.order;
        }
        const permits = await prisma.supplyPermit.findMany({
          where: { supplierId: entityId, deletedAt: null },
          orderBy: { createdAt: "desc" },
          take: 100,
          include: { _count: { select: { items: true } } },
        });
        events.push(
          ...permits.map((p) => ({
            ts: p.createdAt.toISOString(),
            type: "status" as const,
            title: `تصريح توريد ${p.permitNumber}`,
            description: `الأصناف: ${p._count.items}`,
            refType: "supply_permit",
            refId: p.id,
          }))
        );
        break;
      }

      case "warehouse": {
        const [logs, froms, tos] = await Promise.all([
          prisma.inventoryLog.findMany({
            where: { warehouseId: entityId },
            orderBy: { createdAt: "desc" },
            take,
            include: { product: { select: { name: true } } },
          }),
          prisma.transfer.findMany({
            where: { fromWarehouseId: entityId, deletedAt: null },
            orderBy: { createdAt: "desc" },
            take: 100,
            include: { toWarehouse: { select: { name: true } } },
          }),
          prisma.transfer.findMany({
            where: { toWarehouseId: entityId, deletedAt: null },
            orderBy: { createdAt: "desc" },
            take: 100,
            include: { fromWarehouse: { select: { name: true } } },
          }),
        ]);
        events.push(...rowsFromLogs(logs));
        for (const t of froms) {
          events.push({ ts: t.createdAt.toISOString(), type: "transfer", title: `تحويل صادر ${t.transferNumber}`, description: `إلى ${t.toWarehouse?.name || ""} — الحالة ${t.status}`, user: t.createdByName || null, refType: "transfer", refId: t.id });
          if (t.confirmedAt) events.push({ ts: t.confirmedAt.toISOString(), type: "transfer", title: `تأكيد التحويل ${t.transferNumber}`, description: `بواسطة ${t.confirmedByName || "—"}`, user: t.confirmedByName, refType: "transfer", refId: t.id });
          if (t.executedAt) events.push({ ts: t.executedAt.toISOString(), type: "transfer", title: `تنفيذ التحويل ${t.transferNumber}`, description: `خروج من المخزن بواسطة ${t.executedByName || "—"}`, user: t.executedByName, refType: "transfer", refId: t.id });
          if (t.receivedAt) events.push({ ts: t.receivedAt.toISOString(), type: "transfer", title: `استلام التحويل ${t.transferNumber}`, description: `في المخزن الوجهة`, user: t.receivedByName || null, refType: "transfer", refId: t.id });
        }
        for (const t of tos) {
          events.push({ ts: t.createdAt.toISOString(), type: "transfer", title: `تحويل وارد ${t.transferNumber}`, description: `من ${t.fromWarehouse?.name || ""} — الحالة ${t.status}`, user: t.createdByName || null, refType: "transfer", refId: t.id });
          if (t.receivedAt) events.push({ ts: t.receivedAt.toISOString(), type: "transfer", title: `استلام التحويل ${t.transferNumber}`, description: `إلى المخزن الوجهة`, user: t.receivedByName || null, refType: "transfer", refId: t.id });
        }
        break;
      }

      case "purchase_order": {
        const [history, costHistory] = await Promise.all([
          prisma.purchaseOrderStatusHistory.findMany({ where: { orderId: entityId }, orderBy: { createdAt: "desc" }, take }),
          prisma.costHistory.findMany({
            where: { referenceType: "purchase_order", referenceId: entityId },
            orderBy: { createdAt: "desc" },
            take: 200,
            include: { product: { select: { name: true } } },
          }),
        ]);
        events.push(
          ...history.map((h) => ({
            ts: h.createdAt.toISOString(),
            type: "status" as const,
            title: "تغيّر حالة أمر الشراء",
            description: `${h.fromStatus || "—"} → ${h.toStatus}${h.note ? ` — ${h.note}` : ""}`,
            user: h.changedBy || null,
          }))
        );
        events.push(
          ...costHistory.map((c) => ({
            ts: c.createdAt.toISOString(),
            type: "cost" as const,
            title: "تحديث تكلفة من هذا الأمر",
            description: `${c.product?.name || ""}: ${c.oldCost ?? "—"} → ${c.newCost ?? "—"}${c.purchasePrice ? ` (سعر الوحدة ${c.purchasePrice})` : ""}`,
            user: c.userName || null,
            refType: "cost_history",
            refId: c.id,
          }))
        );
        break;
      }

      case "return_order": {
        const history = await prisma.returnOrderStatusHistory.findMany({ where: { returnId: entityId }, orderBy: { createdAt: "desc" }, take });
        const ret = await prisma.returnOrder.findUnique({ where: { id: entityId } });
        events.push(
          ...history.map((h) => ({
            ts: h.createdAt.toISOString(),
            type: "status" as const,
            title: "تغيّر حالة المرتجع",
            description: `${h.fromStatus || "—"} → ${h.toStatus}${h.note ? ` — ${h.note}` : ""}`,
            user: h.changedBy || null,
          }))
        );
        if (ret?.refundDate) {
          events.push({
            ts: ret.refundDate.toISOString(),
            type: "refund",
            title: "ردّ مالي",
            description: `مبلغ ${ret.refundAmount ?? 0}${ret.refundNote ? ` — ${ret.refundNote}` : ""}`,
            user: ret.closedBy || null,
          });
        }
        break;
      }

      default:
        res.status(400).json({ error: `Unsupported entityType: ${entityType}` });
        return;
    }

    events.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
    res.json({ entityType, entityId, events: events.slice(0, take) });
  } catch (err) {
    next(err);
  }
});

export default router;