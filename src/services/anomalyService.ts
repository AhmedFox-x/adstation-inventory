import { Prisma, PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

// ─────────────────────────────────────────────────────────────────────────────
// عتبات الكشف المركزية — أي تعديل مستقبلي (صفحة إعدادات) بيغيّر هنا بس.
// ─────────────────────────────────────────────────────────────────────────────
export const ANOMALY_THRESHOLDS = {
  costSpikeMinPct: 25,      // نسبة ارتفاع التكلفة
  costSpikeMinAmount: 100,  // أو الزيادة بالجنيه (أيهما أكبر)
  suddenStockDropQty: 200,  // خصم مفاجئ من المخزون
  largeUnexpectedChange: 500, // تغيير غير متوقع كبير (غير جردي)
  largeAdjustmentQty: 300,  // تسوية/جرد كبير
  receiveMismatchPct: 10,   // نسبة فرق الاستلام عن الكمية المطلوبة
  deadStockDays: 90,        // أيام بدون حركة
  deadStockMaxEntities: 50, // سقف الشذوذ المتولدة دفعة واحدة
  windows: {
    cost: 7,      // أيام
    drop: 7,
    unexpected: 7,
    adjustment: 30,
    receiveMismatch: 30,
  },
} as const;

export type AnomalyCode =
  | "cost_price_spike"
  | "sudden_stock_drop"
  | "dead_stock"
  | "receive_mismatch"
  | "unexpected_change"
  | "large_adjustment"
  | "negative_stock";

const DAY_MS = 86400000;

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * DAY_MS);
}

async function upsertAnomaly(
  db: Db,
  input: {
    code: AnomalyCode;
    severity: string;
    title: string;
    description: string;
    entityType?: string;
    entityName?: string;
    entityId?: string;
    referenceType?: string;
    referenceId?: string;
    details?: any;
    sourceLogId?: string;
  }
) {
  const key: { code: string; entityType: string | null; entityId: string | null; status: string } = {
    code: input.code,
    entityType: input.entityType ?? null,
    entityId: input.entityId ?? null,
    status: "open",
  };
  const existing = await db.anomaly.findFirst({ where: key, orderBy: { createdAt: "desc" } });
  if (existing) {
    return db.anomaly.update({
      where: { id: existing.id },
      data: {
        timesSeen: { increment: 1 },
        severity: input.severity,
        description: input.description,
        entityName: input.entityName ?? existing.entityName,
        details: input.details ?? existing.details,
        sourceLogId: input.sourceLogId ?? existing.sourceLogId,
      },
    });
  }
  return db.anomaly.create({ data: { ...input, details: input.details ? JSON.parse(JSON.stringify(input.details)) : undefined } });
}

async function getProductName(db: Db, id: string): Promise<string> {
  const p = await db.product.findUnique({ where: { id }, select: { name: true } });
  return p?.name || "";
}

// ─────────────────────────────────────────────────────────────────────────────
// إنشاء سجل شذوذ من أي مكان (تُستخدم عند رفض عملية لسبب مخزون غير كافٍ)
// ─────────────────────────────────────────────────────────────────────────────
export async function recordStockInsufficient(
  db: Db,
  input: {
    productIds: string[];
    message: string;
    actor?: string;
    entityType?: string;
    entityId?: string;
    entityName?: string;
  }
) {
  const code: AnomalyCode = "negative_stock";
  let desc = input.message;
  const details: any = { productIds: input.productIds, attemptActor: input.actor };
  if (input.entityName) details.entityName = input.entityName;

  const existing = await db.anomaly.findFirst({
    where: { code, entityType: input.entityType ?? "sales_order", entityId: input.entityId ?? null, status: "open" },
    orderBy: { createdAt: "desc" },
  });
  if (existing) {
    return db.anomaly.update({
      where: { id: existing.id },
      data: { timesSeen: { increment: 1 }, description: desc, details },
    });
  }
  return db.anomaly.create({
    data: {
      code,
      severity: "high",
      title: "محاولة صرف تتجاوز المتاح من المخزون",
      description: desc,
      entityType: input.entityType ?? "sales_order",
      entityName: input.entityName,
      entityId: input.entityId ?? null,
      details,
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// تشغيل كل قواعد الكشف السبع
// ─────────────────────────────────────────────────────────────────────────────
export async function runAnomalyDetection(db: Db): Promise<{ detected: number; byRule: Record<string, number> }> {
  const T = ANOMALY_THRESHOLDS;
  const byRule: Record<string, number> = {};
  let detected = 0;

  function count(code: string) {
    byRule[code] = (byRule[code] || 0) + 1;
    detected++;
  }

  // ── 1) cost_price_spike: ارتفاع تكلفة مشتريات ≥ 25% أو ≥ 100 جنيه
  const costRows = await db.costHistory.findMany({
    where: { createdAt: { gte: daysAgo(T.windows.cost) }, oldCost: { gt: 0 } },
    take: 2000,
    orderBy: { createdAt: "desc" },
  });
  for (const c of costRows) {
    const pct = ((c.newCost ?? 0) - (c.oldCost ?? 0)) / (c.oldCost ?? 1) * 100;
    const amount = (c.newCost ?? 0) - (c.oldCost ?? 0);
    if (pct >= T.costSpikeMinPct || amount >= T.costSpikeMinAmount) {
      await upsertAnomaly(db, {
        code: "cost_price_spike",
        severity: pct >= 40 ? "critical" : "high",
        title: "ارتفاع غير طبيعي في تكلفة منتج",
        description: `تكلفة المنتج ارتفعت من ${round2(c.oldCost)} إلى ${round2(c.newCost ?? 0)} (${round2(pct)}%)`,
        entityType: "product",
        entityId: c.productId,
        referenceType: c.referenceType ?? undefined,
        referenceId: c.referenceId ?? undefined,
        details: { oldCost: c.oldCost, newCost: c.newCost, pct: round2(pct), reason: c.reason, purchasePrice: c.purchasePrice, userId: c.userId, userName: c.userName },
      });
      count("cost_price_spike");
    }
  }

  // ── 2) sudden_stock_drop + 5) unexpected_change (بنفس أصل السجل)
  const bigLogs = await db.inventoryLog.findMany({
    where: { createdAt: { gte: daysAgo(Math.max(T.windows.drop, T.windows.unexpected)) }, change: { not: 0 } },
    orderBy: { createdAt: "desc" },
    take: 5000,
    include: { product: { select: { name: true } } },
  });
  const EXCLUDED_DECLARED = new Set(["stocktake", "reconciliation", "initial"]);
  for (const log of bigLogs) {
    const abs = Math.abs(log.change);
    const pname = log.product?.name || "";
    if (log.change <= -T.suddenStockDropQty) {
      await upsertAnomaly(db, {
        code: "sudden_stock_drop",
        severity: log.change <= -500 ? "high" : "medium",
        title: "نقص مفاجئ في مخزون منتج",
        description: `${pname}: انخفاض ${log.change} قطعة دفعة واحدة (المتبقي ${log.newStock})`,
        entityType: "product",
        entityId: log.productId,
        entityName: pname,
        referenceType: log.referenceType ?? undefined,
        referenceId: log.referenceId ?? undefined,
        sourceLogId: log.id,
        details: { change: log.change, oldStock: log.oldStock, newStock: log.newStock, type: log.type, salesName: log.salesName, user: log.userName },
      });
      count("sudden_stock_drop");
    }
    if (abs >= T.largeUnexpectedChange && !EXCLUDED_DECLARED.has(log.type)) {
      await upsertAnomaly(db, {
        code: "unexpected_change",
        severity: abs >= 1000 ? "high" : "medium",
        title: "تغيّر كبير غير متوقع في المخزون",
        description: `${pname}: تغيّر ${log.change > 0 ? "+" : ""}${log.change} خارج عمليات الجرد (${log.type})`,
        entityType: "product",
        entityId: log.productId,
        entityName: pname,
        referenceType: log.referenceType ?? undefined,
        referenceId: log.referenceId ?? undefined,
        sourceLogId: log.id,
        details: { change: log.change, oldStock: log.oldStock, newStock: log.newStock, type: log.type, user: log.userName },
      });
      count("unexpected_change");
    }
  }

  // ── 6) large_adjustment: تسوية/جرد كبيرة
  const adjLogs = await db.inventoryLog.findMany({
    where: {
      createdAt: { gte: daysAgo(T.windows.adjustment) },
      type: { in: ["manual_adjust", "reconciliation", "stocktake"] },
      change: { not: 0 },
    },
    orderBy: { createdAt: "desc" },
    take: 2000,
    include: { product: { select: { name: true } } },
  });
  for (const log of adjLogs) {
    if (Math.abs(log.change) >= T.largeAdjustmentQty) {
      await upsertAnomaly(db, {
        code: "large_adjustment",
        severity: Math.abs(log.change) >= 500 ? "high" : "medium",
        title: "تسوية جرد كبيرة",
        description: `${log.product?.name || ""}: ${log.type} غيّر الكمية ب ${log.change} (${log.oldStock} → ${log.newStock})`,
        entityType: "product",
        entityId: log.productId,
        entityName: log.product?.name || "",
        referenceType: log.referenceType ?? undefined,
        referenceId: log.referenceId ?? undefined,
        sourceLogId: log.id,
        details: { change: log.change, oldStock: log.oldStock, newStock: log.newStock, type: log.type, user: log.userName, notes: log.notes },
      });
      count("large_adjustment");
    }
  }

  // ── 4) receive_mismatch: كميات المستلم ≠ المطلوب بأكثر من 10%
  const mismatches = await db.purchaseOrderItem.findMany({
    where: {
      receivedQuantity: { gt: 0 },
      order: { createdAt: { gte: daysAgo(T.windows.receiveMismatch) }, deletedAt: null },
    },
    select: {
      id: true, quantity: true, receivedQuantity: true, rejectedQty: true, productId: true,
      order: { select: { id: true, orderNumber: true } },
      product: { select: { name: true } },
    },
    take: 2000,
  });
  for (const it of mismatches) {
    const expected = it.quantity || 0;
    const diffPct = expected > 0 ? Math.abs(it.receivedQuantity - expected) / expected * 100 : 0;
    if (diffPct >= T.receiveMismatchPct) {
      await upsertAnomaly(db, {
        code: "receive_mismatch",
        severity: diffPct >= 25 ? "high" : "medium",
        title: "الاستلام غير مطابق للطلب",
        description: `${it.order.orderNumber}: المستلم ${it.receivedQuantity} من أصل ${expected} لِ ${it.product?.name || ""} (فرق ${round2(diffPct)}%)`,
        entityType: "purchase_order",
        entityId: it.order.id,
        entityName: it.order.orderNumber,
        referenceType: "purchase_order_item",
        referenceId: it.id,
        details: { productId: it.productId, expected: it.quantity, received: it.receivedQuantity, rejected: it.rejectedQty, diffPct: round2(diffPct) },
      });
      count("receive_mismatch");
    }
  }

  // ── 3) dead_stock: منتجات متبقية من غير حركة ≥ 90 يوم
  const products = await db.product.findMany({
    where: { deletedAt: null, stock: { gt: 0 } },
    select: { id: true, name: true, stock: true, costPrice: true, price: true, updatedAt: true },
    take: 10000,
  });
  const since = daysAgo(T.deadStockDays);
  const lastMoveByProduct = await db.inventoryLog.groupBy({
    by: ["productId"],
    where: { createdAt: { lt: since }, change: { not: 0 } },
    _max: { createdAt: true },
  });
  const lastMoveMap = new Map(lastMoveByProduct.map((l) => [l.productId, l._max.createdAt]));
  const deadCandidates = products
    .map((p) => {
      const lastMove = lastMoveMap.get(p.id);
      const deadDays = lastMove ? Math.floor((Date.now() - lastMove.getTime()) / DAY_MS) : T.deadStockDays + 1;
      return { ...p, deadDays };
    })
    .filter((p) => p.deadDays >= T.deadStockDays)
    .sort((a, b) => (b.stock * (b.costPrice || b.price || 0)) - (a.stock * (a.costPrice || a.price || 0)))
    .slice(0, T.deadStockMaxEntities);
  for (const p of deadCandidates) {
    const value = p.stock * ((p.costPrice && p.costPrice > 0 ? p.costPrice : (p.price ?? 0)) || 0);
    await upsertAnomaly(db, {
      code: "dead_stock",
      severity: "low",
      title: "بضاعة راكدة بدون حركة",
      description: `${p.name}: ${p.stock} قطعة بدون أي حركة منذ ${p.deadDays} يوم`,
      entityType: "product",
      entityId: p.id,
      entityName: p.name,
      details: { stock: p.stock, value: round2(value), deadDays: p.deadDays },
    });
    count("dead_stock");
  }

  // ── 7) negative_stock (backstop): أي سجل بيحوي رصيد سالب (لا يجب أن يحدث)
  const negLogs = await db.inventoryLog.findMany({
    where: { newStock: { lt: 0 } },
    orderBy: { createdAt: "desc" },
    take: 200,
    include: { product: { select: { name: true } } },
  });
  for (const nl of negLogs) {
    await upsertAnomaly(db, {
      code: "negative_stock",
      severity: "critical",
      title: "رصيد سالب في نظام المخزون",
      description: `${nl.product?.name || ""}: الرصيد أصبح ${nl.newStock} بعد عملية ${nl.type}`,
      entityType: "product",
      entityId: nl.productId,
      entityName: nl.product?.name || "",
      referenceType: nl.referenceType ?? undefined,
      referenceId: nl.referenceId ?? undefined,
      sourceLogId: nl.id,
      details: { oldStock: nl.oldStock, newStock: nl.newStock, change: nl.change, type: nl.type },
    });
    count("negative_stock");
  }

  return { detected, byRule };
}

export async function summarizeAnomalies(db: Db) {
  const groups = await db.anomaly.groupBy({ by: ["status"], _count: { _all: true } });
  const bySeverity = await db.anomaly.groupBy({ by: ["severity"], where: { status: "open" }, _count: { _all: true } });
  return {
    open: groups.find((g) => g.status === "open")?._count._all ?? 0,
    reviewing: groups.find((g) => g.status === "reviewing")?._count._all ?? 0,
    resolved: groups.find((g) => g.status === "resolved")?._count._all ?? 0,
    bySeverity: Object.fromEntries(bySeverity.map((s) => [s.severity, s._count._all])),
  };
}

function round2(n: number | null | undefined): number {
  return Math.round((n ?? 0) * 100) / 100;
}