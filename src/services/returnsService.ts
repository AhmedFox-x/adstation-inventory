import { Prisma, PrismaClient } from "@prisma/client";

type Tx = Prisma.TransactionClient;

export interface ServiceUser {
  userId: string;
  name?: string;
}

export interface RequestMeta {
  ip?: string;
  userAgent?: string;
}

export interface ReturnItemInput {
  productId: string;
  sourceItemId?: string;
  condition: string;
  reason: string;
  returnedQty: number;
  unitPrice?: number;
  imageBefore?: string;
  imageAfter?: string;
  notes?: string;
}

export interface CreateReturnInput {
  type: string;
  sourceType: string;
  sourceId: string;
  warehouseDestination?: string;
  notes?: string;
  images?: any[];
  items: ReturnItemInput[];
}

export interface UpdateReturnInput extends CreateReturnInput {
  expectedVersion?: number;
}

export interface ReceiveItemInput {
  itemId: string;
  receivedQty: number;
}

export interface ReceiveInput {
  items: ReceiveItemInput[];
}

export interface RefundInput {
  refundStatus: string;
  refundAmount?: number;
  refundNote?: string;
  refundDate?: string;
}

export interface CloseInput {
  resolution: string;
  replacementOrderId?: string;
}

// ─── Constants & Enums ───────────────────────────────────────────────────────

export const RETURN_STATUSES = {
  DRAFT: "draft",
  APPROVED: "approved",
  RECEIVED: "received",
  CLOSED: "closed",
  REJECTED: "rejected",
} as const;

export const RETURN_TYPES = {
  CUSTOMER: "customer_return",
  SUPPLIER: "supplier_return",
} as const;

export const SOURCE_TYPES = {
  SALES_ORDER: "sales_order",
  PURCHASE_ORDER: "purchase_order",
  WITHDRAWAL: "withdrawal",
  DELIVERY: "delivery",
} as const;

export const CONDITIONS = {
  NEW: "new",
  OPENED: "opened",
  USED: "used",
  DAMAGED: "damaged",
  NEEDS_INSPECTION: "needs_inspection",
} as const;

export const REASONS = {
  DAMAGED: "damaged",
  WRONG_ITEM: "wrong_item",
  EXPIRED: "expired",
  WARRANTY: "warranty",
  CHANGED_MIND: "changed_mind",
  FACTORY_DEFECT: "factory_defect",
  SHIPPING_DAMAGE: "shipping_damage",
  OTHER: "other",
} as const;

export const WAREHOUSE_DESTINATIONS = {
  MAIN: "main",
  RETURNS: "returns",
  QUARANTINE: "quarantine",
} as const;

export const REFUND_STATUSES = {
  NONE: "none",
  PENDING: "pending",
  PARTIAL: "partial",
  COMPLETED: "completed",
} as const;

export const RESOLUTIONS = {
  REFUND: "refund",
  REPLACE: "replace",
  REPAIR: "repair",
  CREDIT_NOTE: "credit_note",
} as const;

// حالة ممنوعة مع الوجهة: التالف/قيد الفحص يجب أن يدخل Quarantine حصرًا
const QUARANTINE_CONDITIONS: Set<string> = new Set([CONDITIONS.DAMAGED, CONDITIONS.NEEDS_INSPECTION]);
const VALID_CONDITIONS: Set<string> = new Set(Object.values(CONDITIONS));
const VALID_REASONS: Set<string> = new Set(Object.values(REASONS));
const VALID_WAREHOUSES: Set<string> = new Set(Object.values(WAREHOUSE_DESTINATIONS));
const VALID_REFUND_STATUSES: Set<string> = new Set(Object.values(REFUND_STATUSES));
const VALID_RESOLUTIONS: Set<string> = new Set(Object.values(RESOLUTIONS));

export const VALID_TRANSITIONS: Record<string, string[]> = {
  draft: ["approved", "rejected"],
  approved: ["received"],
  received: ["closed"],
  closed: [],
  rejected: [],
};

const ALLOWED_SOURCE_BY_TYPE: Record<string, string[]> = {
  [RETURN_TYPES.CUSTOMER]: [SOURCE_TYPES.SALES_ORDER, SOURCE_TYPES.WITHDRAWAL, SOURCE_TYPES.DELIVERY],
  [RETURN_TYPES.SUPPLIER]: [SOURCE_TYPES.PURCHASE_ORDER],
};

export class ReturnError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const TX_TIMEOUT = 30000;

async function runTx<T>(client: PrismaClient, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return client.$transaction(fn, { timeout: TX_TIMEOUT });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

async function lockProducts(tx: Tx, productIds: string[]) {
  if (productIds.length === 0) return;
  await tx.$queryRaw`SELECT id FROM "Product" WHERE id IN (${Prisma.join(productIds)}) FOR UPDATE`;
}

async function getActiveOwners(tx: Tx) {
  return tx.user.findMany({
    where: { roleConfig: { name: "owner" } },
    select: { id: true },
  });
}

async function getRefundDueDays(tx: Tx): Promise<number> {
  const row = await tx.systemSettings.findUnique({ where: { key: "refundDueDays" } });
  const value = row ? Number(row.value) : 7;
  return Number.isFinite(value) && value > 0 ? value : 7;
}

function getReturnFullQuery() {
  return {
    include: {
      items: {
        orderBy: { id: "asc" },
        include: {
          product: { select: { id: true, name: true, stock: true, quarantineStock: true, reservedStock: true, sku: true } },
        },
      },
      statusHistory: { orderBy: { createdAt: "asc" } },
    },
  } as const;
}

async function getReturnFull(tx: Tx, id: string) {
  return tx.returnOrder.findUnique({ where: { id }, ...getReturnFullQuery() });
}

async function requireReturnFull(tx: Tx, id: string) {
  const ret = await getReturnFull(tx, id);
  if (!ret || ret.deletedAt) throw new ReturnError("Return not found", 404);
  return ret;
}

function snapshotProduct(product: any) {
  return {
    productName: product.name || null,
    productSku: product.sku || null,
    unit: product.unit || "قطعة",
  };
}

async function generateReturnNumber(tx: Tx, type: string): Promise<string> {
  const now = new Date();
  const ym = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;
  const prefix = type === RETURN_TYPES.SUPPLIER ? `SR-${ym}-` : `RT-${ym}-`;
  const last = await tx.returnOrder.findFirst({
    where: { returnNumber: { startsWith: prefix } },
    orderBy: { returnNumber: "desc" },
    select: { returnNumber: true },
  });
  const next = last ? Number(last.returnNumber.slice(prefix.length)) + 1 : 1;
  return `${prefix}${String(next).padStart(6, "0")}`;
}

// حساب الكمية القابلة للإرجاع لكل منتج من المصدر، وطرح ما سبق إرجاعه
async function getSourceCapacity(
  tx: Tx,
  sourceType: string,
  sourceId: string,
  excludeReturnId?: string
): Promise<{ max: Map<string, number>; sourceNumber: string; partyId: string | null; partyName: string }> {
  const max = new Map<string, number>();
  let sourceNumber = "";
  let partyId: string | null = null;
  let partyName = "";

  if (sourceType === SOURCE_TYPES.SALES_ORDER) {
    const order = await tx.salesOrder.findUnique({
      where: { id: sourceId },
      include: { items: true, client: { select: { id: true, name: true } } },
    });
    if (!order || order.deletedAt) throw new ReturnError("Source SalesOrder not found", 404);
    sourceNumber = order.orderNumber;
    partyId = order.clientId;
    partyName = order.client?.name || "";
    for (const item of order.items) {
      max.set(item.productId, (max.get(item.productId) || 0) + item.deliveredQty);
    }
  } else if (sourceType === SOURCE_TYPES.PURCHASE_ORDER) {
    const po = await tx.purchaseOrder.findUnique({
      where: { id: sourceId },
      include: { items: true, supplier: { select: { id: true, name: true } } },
    });
    if (!po) throw new ReturnError("Source PurchaseOrder not found", 404);
    if (po.status !== "received") throw new ReturnError("Purchase order must be received", 400);
    sourceNumber = po.orderNumber;
    partyId = po.supplierId;
    partyName = po.supplier?.name || "";
    for (const item of po.items) {
      max.set(item.productId, (max.get(item.productId) || 0) + item.receivedQuantity);
    }
  } else if (sourceType === SOURCE_TYPES.WITHDRAWAL) {
    const permit = await tx.withdrawalPermit.findUnique({
      where: { id: sourceId },
      include: { items: true, client: { select: { id: true, name: true } } },
    });
    if (!permit) throw new ReturnError("Source WithdrawalPermit not found", 404);
    sourceNumber = permit.permitNumber;
    partyId = permit.clientId || null;
    partyName = permit.clientName || permit.client?.name || "";
    for (const item of permit.items) {
      max.set(item.productId, (max.get(item.productId) || 0) + item.quantityActual);
    }
  } else if (sourceType === SOURCE_TYPES.DELIVERY) {
    const delivery = await tx.salesDelivery.findUnique({
      where: { id: sourceId },
      include: { items: true, salesOrder: { include: { client: { select: { id: true, name: true } } } } },
    });
    if (!delivery) throw new ReturnError("Source SalesDelivery not found", 404);
    sourceNumber = delivery.deliveryNumber;
    partyId = delivery.salesOrder?.clientId || null;
    partyName = delivery.salesOrder?.client?.name || "";
    for (const item of delivery.items) {
      max.set(item.productId, (max.get(item.productId) || 0) + item.quantity);
    }
  } else {
    throw new ReturnError(`Unsupported sourceType: ${sourceType}`, 400);
  }

  // ما سبق إرجاعه على نفس المصدر (غير مرفوض وغير مؤرشف وغير هذا المرتجع نفسه)
  const prior = await tx.returnOrder.findMany({
    where: {
      sourceType,
      sourceId,
      deletedAt: null,
      status: { in: [RETURN_STATUSES.DRAFT, RETURN_STATUSES.APPROVED, RETURN_STATUSES.RECEIVED, RETURN_STATUSES.CLOSED] },
      ...(excludeReturnId ? { id: { not: excludeReturnId } } : {}),
    },
    select: { items: { select: { productId: true, returnedQty: true } } },
  });

  const already = new Map<string, number>();
  for (const ret of prior) {
    for (const it of ret.items) {
      already.set(it.productId, (already.get(it.productId) || 0) + it.returnedQty);
    }
  }

  for (const [productId, cap] of max) {
    const used = already.get(productId) || 0;
    if (used >= cap) max.set(productId, 0);
    else max.set(productId, cap - used);
  }

  return { max, sourceNumber, partyId, partyName };
}

function validateItemFields(item: ReturnItemInput) {
  if (!item.productId) throw new ReturnError("item productId is required", 400);
  if (!item.condition || !VALID_CONDITIONS.has(item.condition)) {
    throw new ReturnError(`item condition must be one of: ${Object.values(CONDITIONS).join(", ")}`, 400);
  }
  if (!item.reason || !VALID_REASONS.has(item.reason)) {
    throw new ReturnError(`item reason must be one of: ${Object.values(REASONS).join(", ")}`, 400);
  }
  if (!Number(item.returnedQty) || Number(item.returnedQty) <= 0) {
    throw new ReturnError("item returnedQty must be positive", 400);
  }
}

async function validateWarehouseConsistency(tx: Tx, warehouseDestination: string, items: ReturnItemInput[]) {
  if (!VALID_WAREHOUSES.has(warehouseDestination)) {
    throw new ReturnError(`warehouseDestination must be one of: ${Object.values(WAREHOUSE_DESTINATIONS).join(", ")}`, 400);
  }
  const damaged = items.some((i) => QUARANTINE_CONDITIONS.has(i.condition));
  if (damaged && warehouseDestination !== WAREHOUSE_DESTINATIONS.QUARANTINE) {
    throw new ReturnError("Damaged items must go to quarantine", 400);
  }
}

function calcSubtotal(items: ReturnItemInput[]): number {
  return round2(items.reduce((sum, i) => sum + (Number(i.unitPrice) || 0) * Number(i.returnedQty), 0));
}

async function checkItemsAgainstSource(
  tx: Tx,
  sourceType: string,
  sourceId: string,
  items: ReturnItemInput[],
  excludeReturnId?: string
) {
  const capacity = await getSourceCapacity(tx, sourceType, sourceId, excludeReturnId);
  const grouped = new Map<string, number>();
  for (const item of items) {
    grouped.set(item.productId, (grouped.get(item.productId) || 0) + Number(item.returnedQty));
  }
  for (const [productId, qty] of grouped) {
    const remaining = capacity.max.get(productId) ?? 0;
    if (qty > remaining) {
      throw new ReturnError(`Cannot return more than delivered (${remaining} available for this product)`, 409);
    }
  }
  return capacity;
}

// ─── Create ───────────────────────────────────────────────────────────────────

export async function createReturn(client: PrismaClient, input: CreateReturnInput, user: ServiceUser, meta: RequestMeta = {}) {
  if (!input.type || !ALLOWED_SOURCE_BY_TYPE[input.type]) {
    throw new ReturnError("Return type is required (customer_return | supplier_return)", 400);
  }
  if (!input.sourceType || !input.sourceId) throw new ReturnError("sourceType and sourceId are required", 400);
  if (!ALLOWED_SOURCE_BY_TYPE[input.type].includes(input.sourceType)) {
    throw new ReturnError(`sourceType ${input.sourceType} is not allowed for ${input.type}`, 400);
  }
  if (!Array.isArray(input.items) || input.items.length === 0) throw new ReturnError("items is required", 400);
  for (const it of input.items) validateItemFields(it);

  const warehouseDestination = input.warehouseDestination || WAREHOUSE_DESTINATIONS.RETURNS;

  return runTx(client, async (tx) => {
    const capacity = await checkItemsAgainstSource(tx, input.sourceType, input.sourceId, input.items);
    await validateWarehouseConsistency(tx, warehouseDestination, input.items);
    const products = await tx.product.findMany({ where: { id: { in: input.items.map((i) => i.productId) } } });
    const productMap = new Map(products.map((p) => [p.id, p]));
    for (const it of input.items) {
      if (!productMap.has(it.productId)) throw new ReturnError(`Product not found: ${it.productId}`, 404);
    }

    const returnNumber = await generateReturnNumber(tx, input.type);
    const subtotal = calcSubtotal(input.items);

    const created = await tx.returnOrder.create({
      data: {
        returnNumber,
        type: input.type,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        sourceNumber: capacity.sourceNumber,
        partyId: capacity.partyId,
        partyName: capacity.partyName,
        warehouseDestination,
        subtotal,
        notes: input.notes || null,
        images: input.images && input.images.length ? (input.images as Prisma.InputJsonValue) : undefined,
        createdBy: user.userId,
        statusHistory: {
          create: {
            toStatus: RETURN_STATUSES.DRAFT,
            changedBy: user.userId,
            ip: meta.ip,
            userAgent: meta.userAgent,
            changedFields: ["created"],
          },
        },
        items: {
          create: input.items.map((it) => {
            const product = productMap.get(it.productId)!;
            const price = Number(it.unitPrice) || 0;
            return {
              productId: it.productId,
              sourceItemId: it.sourceItemId || null,
              condition: it.condition,
              reason: it.reason,
              returnedQty: Number(it.returnedQty),
              unitPrice: price,
              totalPrice: round2(price * Number(it.returnedQty)),
              imageBefore: it.imageBefore || null,
              imageAfter: it.imageAfter || null,
              notes: it.notes || null,
              ...snapshotProduct(product),
            };
          }),
        },
      },
      ...getReturnFullQuery(),
    });

    const owners = await getActiveOwners(tx);
    for (const owner of owners) {
      await tx.notification.create({
        data: {
          userId: owner.id,
          type: "return_approval_needed",
          title: "مرتجع يحتاج اعتماد",
          message: `المرتجع ${returnNumber} من ${capacity.partyName || ""} يحتاج اعتماد (${subtotal} EGP)`,
          entityType: "return_order",
          entityId: created.id,
          referenceType: "returns",
          referenceId: created.id,
          priority: "high",
          icon: "ShieldAlert",
          createdBySystem: true,
        },
      });
    }
    await tx.notification.create({
      data: {
        userId: user.userId,
        type: "return_created",
        title: "تم إنشاء المرتجع",
        message: `تم إنشاء المرتجع ${returnNumber} ورفعه للاعتماد`,
        entityType: "return_order",
        entityId: created.id,
        referenceType: "returns",
        referenceId: created.id,
        priority: "normal",
        icon: "PackagePlus",
        createdBySystem: true,
      },
    });

    return requireReturnFull(tx, created.id);
  });
}

// ─── Update (draft only, optimistic locking) ──────────────────────────────────

export async function updateReturn(client: PrismaClient, id: string, input: UpdateReturnInput, user: ServiceUser, meta: RequestMeta = {}) {
  if (!input.sourceType || !input.sourceId) throw new ReturnError("sourceType and sourceId are required", 400);
  if (!Array.isArray(input.items) || input.items.length === 0) throw new ReturnError("items is required", 400);
  for (const it of input.items) validateItemFields(it);
  const warehouseDestination = input.warehouseDestination || WAREHOUSE_DESTINATIONS.RETURNS;

  return runTx(client, async (tx) => {
    const existing = await tx.returnOrder.findUnique({ where: { id }, include: { items: true } });
    if (!existing || existing.deletedAt) throw new ReturnError("Return not found", 404);
    if (existing.status !== RETURN_STATUSES.DRAFT) throw new ReturnError("Only draft returns can be edited", 400);

    const expectedVersion = input.expectedVersion ?? existing.version;
    if (expectedVersion !== existing.version) {
      throw new ReturnError("Return was modified by another user. Refresh and retry.", 409);
    }

    const capacity = await checkItemsAgainstSource(tx, input.sourceType, input.sourceId, input.items, id);
    await validateWarehouseConsistency(tx, warehouseDestination, input.items);
    const products = await tx.product.findMany({ where: { id: { in: input.items.map((i) => i.productId) } } });
    const productMap = new Map(products.map((p) => [p.id, p]));
    for (const it of input.items) {
      if (!productMap.has(it.productId)) throw new ReturnError(`Product not found: ${it.productId}`, 404);
    }

    const subtotal = calcSubtotal(input.items);
    await tx.returnOrderItem.deleteMany({ where: { returnId: id } });

    const updated = await tx.returnOrder.update({
      where: { id },
      data: {
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        sourceNumber: capacity.sourceNumber,
        partyId: capacity.partyId,
        partyName: capacity.partyName,
        warehouseDestination,
        subtotal,
        notes: input.notes || null,
        images: input.images && input.images.length ? (input.images as Prisma.InputJsonValue) : undefined,
        version: { increment: 1 },
        statusHistory: {
          create: {
            toStatus: RETURN_STATUSES.DRAFT,
            changedBy: user.userId,
            note: "Return edited",
            ip: meta.ip,
            userAgent: meta.userAgent,
            changedFields: ["items", "subtotal", "warehouseDestination", "version"],
          },
        },
        items: {
          create: input.items.map((it) => {
            const product = productMap.get(it.productId)!;
            const price = Number(it.unitPrice) || 0;
            return {
              productId: it.productId,
              sourceItemId: it.sourceItemId || null,
              condition: it.condition,
              reason: it.reason,
              returnedQty: Number(it.returnedQty),
              unitPrice: price,
              totalPrice: round2(price * Number(it.returnedQty)),
              imageBefore: it.imageBefore || null,
              imageAfter: it.imageAfter || null,
              notes: it.notes || null,
              ...snapshotProduct(product),
            };
          }),
        },
      },
    });

    return requireReturnFull(tx, updated.id);
  });
}

// ─── Transitions ──────────────────────────────────────────────────────────────

async function transitionReturn(
  client: PrismaClient,
  id: string,
  to: string,
  user: ServiceUser,
  meta: RequestMeta,
  extra: {
    fields?: Record<string, any>;
    changedFields?: string[];
    note?: string;
    notifications?: Array<{ type: string; title: string; message: string; userId?: string; priority?: string; icon?: string }>;
  } = {}
) {
  return runTx(client, async (tx) => {
    const ret = await tx.returnOrder.findUnique({ where: { id } });
    if (!ret || ret.deletedAt) throw new ReturnError("Return not found", 404);
    const valid = VALID_TRANSITIONS[ret.status] || [];
    if (!valid.includes(to)) {
      throw new ReturnError(`Cannot transition from ${ret.status} to ${to}`, 400);
    }

    const updated = await tx.returnOrder.update({
      where: { id },
      data: {
        status: to,
        version: { increment: 1 },
        ...extra.fields,
        statusHistory: {
          create: {
            fromStatus: ret.status,
            toStatus: to,
            changedBy: user.userId,
            note: extra.note || null,
            ip: meta.ip,
            userAgent: meta.userAgent,
            changedFields: extra.changedFields || ["status", "version"],
            beforeState: JSON.parse(JSON.stringify({ status: ret.status, version: ret.version })),
            afterState: JSON.parse(JSON.stringify({ status: to, version: ret.version + 1 })),
          },
        },
      },
    });

    for (const n of extra.notifications || []) {
      await tx.notification.create({
        data: {
          userId: n.userId,
          type: n.type,
          title: n.title,
          message: n.message,
          entityType: "return_order",
          entityId: id,
          referenceType: "returns",
          referenceId: id,
          priority: n.priority || "normal",
          icon: n.icon || "Bell",
          createdBySystem: true,
        },
      });
    }

    return requireReturnFull(tx, updated.id);
  });
}

export async function approveReturn(client: PrismaClient, id: string, user: ServiceUser, meta: RequestMeta = {}) {
  const ret = await client.returnOrder.findUnique({ where: { id } });
  if (!ret || ret.deletedAt) throw new ReturnError("Return not found", 404);

  return transitionReturn(client, id, RETURN_STATUSES.APPROVED, user, meta, {
    fields: { approvedBy: user.userId, approvedAt: new Date() },
    changedFields: ["status", "approvedBy", "approvedAt", "version"],
    notifications: [
      {
        userId: ret.createdBy || user.userId,
        type: "return_approved",
        title: "تم اعتماد المرتجع",
        message: `تم اعتماد المرتجع ${ret.returnNumber}`,
        icon: "BadgeCheck",
      },
    ],
  });
}

export async function rejectReturn(client: PrismaClient, id: string, user: ServiceUser, meta: RequestMeta = {}, reason?: string) {
  if (!reason || !reason.trim()) throw new ReturnError("reason is required", 400);
  const ret = await client.returnOrder.findUnique({ where: { id } });
  if (!ret || ret.deletedAt) throw new ReturnError("Return not found", 404);

  return transitionReturn(client, id, RETURN_STATUSES.REJECTED, user, meta, {
    fields: { rejectedBy: user.userId, rejectedAt: new Date(), rejectionReason: reason.trim() },
    changedFields: ["status", "rejectedBy", "rejectedAt", "rejectionReason", "version"],
    notifications: [
      {
        userId: ret.createdBy || user.userId,
        type: "return_rejected",
        title: "تم رفض المرتجع",
        message: `تم رفض المرتجع ${ret.returnNumber} — ${reason.trim()}`,
        priority: "urgent",
        icon: "XCircle",
      },
    ],
  });
}

// ─── Receive (the only stock-effect step) ─────────────────────────────────────

export async function receiveReturn(client: PrismaClient, id: string, input: ReceiveInput, user: ServiceUser, meta: RequestMeta = {}) {
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new ReturnError("items is required", 400);
  }
  for (const ri of input.items) {
    if (!ri.itemId || !Number.isFinite(Number(ri.receivedQty))) {
      throw new ReturnError("Each item must have itemId and numeric receivedQty", 400);
    }
  }

  return runTx(client, async (tx) => {
    const ret = await tx.returnOrder.findUnique({ where: { id }, include: { items: true } });
    if (!ret || ret.deletedAt) throw new ReturnError("Return not found", 404);

    const productIds = ret.items.map((i) => i.productId);
    await lockProducts(tx, productIds);

    // إعادة قراءة بعد الحصول على Row Locks — يمنع الاستلام المزدوج
    const fresh = await tx.returnOrder.findUnique({ where: { id }, include: { items: true } });
    if (!fresh || fresh.deletedAt) throw new ReturnError("Return not found", 404);
    if (fresh.status !== RETURN_STATUSES.APPROVED) {
      throw new ReturnError(`Cannot receive return in status ${fresh.status}`, 400);
    }

    const products = await tx.product.findMany({ where: { id: { in: productIds } } });
    const productMap = new Map(products.map((p) => [p.id, p]));
    const itemMap = new Map(fresh.items.map((i) => [i.id, i]));

    // تحقق نهائي من سقف الكميات بعد القفل
    const groupByProduct = new Map<string, number>();
    for (const ri of input.items) {
      const item = itemMap.get(ri.itemId);
      if (!item) throw new ReturnError(`Item ${ri.itemId} not found in return`, 404);
      const qty = Number(ri.receivedQty);
      if (qty < 0 || qty > item.returnedQty) {
        throw new ReturnError(`receivedQty must be between 0 and returnedQty (${item.returnedQty})`, 400);
      }
      groupByProduct.set(item.productId, (groupByProduct.get(item.productId) || 0) + qty);
    }
    const capacity = await getSourceCapacity(tx, fresh.sourceType, fresh.sourceId, fresh.id);
    for (const [productId, qty] of groupByProduct) {
      if (qty > (capacity.max.get(productId) ?? 0)) {
        throw new ReturnError(`Cannot return more than delivered (${capacity.max.get(productId) ?? 0} available)`, 409);
      }
    }

    const isSupplier = fresh.type === RETURN_TYPES.SUPPLIER;

    // تتبّع الكمية المتغيّرة أثناء الاستلام — قبل/بعد دقيق حتى لو نفس المنتج تكرر في عدة بنود
    const runningStock = new Map<string, number>();
    for (const [pid, p] of productMap) runningStock.set(pid, p.stock);

    for (const ri of input.items) {
      const item = itemMap.get(ri.itemId)!;
      const qty = Number(ri.receivedQty);
      if (qty <= 0) continue;

      const product = productMap.get(item.productId);
      if (!product) throw new ReturnError(`Product not found: ${item.productId}`, 404);

      let note: string;
      const currentStock = runningStock.get(item.productId) ?? product.stock;
      if (isSupplier) {
        note = `إرجاع ${qty} وحدة من ${product.name} للمورّد (${fresh.sourceNumber})`;
        await tx.product.update({
          where: { id: item.productId },
          data: { stock: { decrement: qty } },
        });
        runningStock.set(item.productId, currentStock - qty);
      } else if (QUARANTINE_CONDITIONS.has(item.condition)) {
        note = `استلام مرتجع ${qty} وحدة من ${product.name} (حالة: تالف/فحص → حجر) — ${fresh.sourceNumber}`;
        await tx.product.update({
          where: { id: item.productId },
          data: { quarantineStock: { increment: qty } },
        });
      } else {
        note = `استلام مرتجع ${qty} وحدة من ${product.name} من ${fresh.partyName || ""} — ${fresh.sourceNumber}`;
        await tx.product.update({
          where: { id: item.productId },
          data: { stock: { increment: qty } },
        });
        runningStock.set(item.productId, currentStock + qty);
      }

      await tx.returnOrderItem.update({
        where: { id: item.id },
        data: { receivedQty: qty },
      });

      const before = currentStock;
      const after = isSupplier
        ? currentStock - qty
        : QUARANTINE_CONDITIONS.has(item.condition)
        ? currentStock
        : currentStock + qty;

      await tx.inventoryLog.create({
        data: {
          type: isSupplier ? "SUPPLIER_RETURN" : "CUSTOMER_RETURN",
          productId: item.productId,
          oldStock: before,
          newStock: after,
          change: isSupplier ? -qty : qty,
          clientName: fresh.partyName || "",
          salesName: user.name || "",
          notes: note,
          referenceType: "returns",
          referenceId: fresh.id,
        },
      });
    }

    const updated = await tx.returnOrder.update({
      where: { id },
      data: {
        status: RETURN_STATUSES.RECEIVED,
        receivedBy: user.userId,
        receivedAt: new Date(),
        version: { increment: 1 },
        statusHistory: {
          create: {
            fromStatus: RETURN_STATUSES.APPROVED,
            toStatus: RETURN_STATUSES.RECEIVED,
            changedBy: user.userId,
            ip: meta.ip,
            userAgent: meta.userAgent,
            changedFields: ["status", "receivedBy", "receivedAt", "stock", "quarantineStock", "version"],
            beforeState: JSON.parse(JSON.stringify({ status: fresh.status, version: fresh.version })),
            afterState: JSON.parse(JSON.stringify({ status: RETURN_STATUSES.RECEIVED, version: fresh.version + 1 })),
          },
        },
      },
    });

    const recipients = new Set<string>([fresh.createdBy || user.userId]);
    if (fresh.approvedBy) recipients.add(fresh.approvedBy);
    for (const recipientId of recipients) {
      await tx.notification.create({
        data: {
          userId: recipientId,
          type: "return_received",
          title: "تم استلام المرتجع",
          message: `تم استلام المرتجع ${fresh.returnNumber} وتحديث المخزون`,
          entityType: "return_order",
          entityId: fresh.id,
          referenceType: "returns",
          referenceId: fresh.id,
          priority: "normal",
          icon: "PackageCheck",
          createdBySystem: true,
        },
      });
    }

    return requireReturnFull(tx, updated.id);
  });
}

// ─── Refund ───────────────────────────────────────────────────────────────────

export async function refundReturn(client: PrismaClient, id: string, input: RefundInput, user: ServiceUser, meta: RequestMeta = {}) {
  if (!input.refundStatus || !VALID_REFUND_STATUSES.has(input.refundStatus) || input.refundStatus === REFUND_STATUSES.NONE) {
    throw new ReturnError("refundStatus must be one of: pending, partial, completed", 400);
  }

  return runTx(client, async (tx) => {
    const ret = await tx.returnOrder.findUnique({ where: { id } });
    if (!ret || ret.deletedAt) throw new ReturnError("Return not found", 404);
    if (ret.status !== RETURN_STATUSES.RECEIVED) {
      throw new ReturnError("Refund requires received status", 400);
    }

    const refundDate = input.refundDate ? new Date(input.refundDate) : new Date();
    const amount = Number(input.refundAmount) || 0;
    const isComplete = input.refundStatus === REFUND_STATUSES.COMPLETED;
    const refundDueAt = isComplete
      ? null
      : new Date(refundDate.getTime() + (await getRefundDueDays(tx)) * 24 * 60 * 60 * 1000);

    const updated = await tx.returnOrder.update({
      where: { id },
      data: {
        refundStatus: input.refundStatus,
        refundAmount: amount,
        refundNote: input.refundNote || null,
        refundDate,
        refundDueAt,
        version: { increment: 1 },
        statusHistory: {
          create: {
            fromStatus: RETURN_STATUSES.RECEIVED,
            toStatus: RETURN_STATUSES.RECEIVED,
            changedBy: user.userId,
            note: `Refund ${input.refundStatus} — ${amount} ${ret.currency || "EGP"}${input.refundNote ? " (" + input.refundNote + ")" : ""}`,
            ip: meta.ip,
            userAgent: meta.userAgent,
            changedFields: ["refundStatus", "refundAmount", "refundDate", "refundDueAt", "version"],
            beforeState: JSON.parse(JSON.stringify({ status: ret.status, version: ret.version, refundStatus: ret.refundStatus })),
            afterState: JSON.parse(JSON.stringify({ status: ret.status, version: ret.version + 1, refundStatus: input.refundStatus })),
          },
        },
      },
    });

    await tx.notification.create({
      data: {
        userId: ret.createdBy || user.userId,
        type: isComplete ? "return_refund_completed" : "return_refund_pending",
        title: isComplete ? "تم استكمال الـ Refund" : "تم تسجيل Refund معلّق",
        message: `${isComplete ? "تم استكمال" : "تم تسجيل"} الـ Refund للمرتجع ${ret.returnNumber} — ${amount} ${ret.currency || "EGP"}`,
        entityType: "return_order",
        entityId: ret.id,
        referenceType: "returns",
        referenceId: ret.id,
        priority: "normal",
        icon: "Banknote",
        createdBySystem: true,
      },
    });

    return requireReturnFull(tx, updated.id);
  });
}

// ─── Close ────────────────────────────────────────────────────────────────────

export async function closeReturn(client: PrismaClient, id: string, input: CloseInput, user: ServiceUser, meta: RequestMeta = {}) {
  if (!input.resolution || !VALID_RESOLUTIONS.has(input.resolution)) {
    throw new ReturnError(`resolution must be one of: ${Object.values(RESOLUTIONS).join(", ")}`, 400);
  }

  return runTx(client, async (tx) => {
    const ret = await tx.returnOrder.findUnique({ where: { id } });
    if (!ret || ret.deletedAt) throw new ReturnError("Return not found", 404);
    if (ret.status !== RETURN_STATUSES.RECEIVED) {
      throw new ReturnError("Cannot close return in status " + ret.status, 400);
    }
    if (input.resolution === RESOLUTIONS.REFUND && ret.refundStatus === REFUND_STATUSES.NONE) {
      throw new ReturnError("Refund status must be set before closing a refund resolution", 400);
    }

    const updated = await tx.returnOrder.update({
      where: { id },
      data: {
        status: RETURN_STATUSES.CLOSED,
        closedBy: user.userId,
        closedAt: new Date(),
        resolution: input.resolution,
        replacementOrderId: input.replacementOrderId || null,
        version: { increment: 1 },
        statusHistory: {
          create: {
            fromStatus: RETURN_STATUSES.RECEIVED,
            toStatus: RETURN_STATUSES.CLOSED,
            changedBy: user.userId,
            note: `Closed with resolution: ${input.resolution}`,
            ip: meta.ip,
            userAgent: meta.userAgent,
            changedFields: ["status", "resolution", "replacementOrderId", "closedBy", "closedAt", "version"],
            beforeState: JSON.parse(JSON.stringify({ status: ret.status, version: ret.version })),
            afterState: JSON.parse(JSON.stringify({ status: RETURN_STATUSES.CLOSED, version: ret.version + 1, resolution: input.resolution })),
          },
        },
      },
    });

    await tx.notification.create({
      data: {
        userId: ret.createdBy || user.userId,
        type: "return_closed",
        title: "تم إقفال المرتجع",
        message: `تم إقفال المرتجع ${ret.returnNumber} (القرار: ${input.resolution})`,
        entityType: "return_order",
        entityId: ret.id,
        referenceType: "returns",
        referenceId: ret.id,
        priority: "normal",
        icon: "Lock",
        createdBySystem: true,
      },
    });

    return requireReturnFull(tx, updated.id);
  });
}

// ─── Archive (Soft Delete — draft only) ───────────────────────────────────────

export async function archiveReturn(client: PrismaClient, id: string, user: ServiceUser, meta: RequestMeta = {}) {
  return runTx(client, async (tx) => {
    const ret = await tx.returnOrder.findUnique({ where: { id } });
    if (!ret) throw new ReturnError("Return not found", 404);
    if (ret.deletedAt) throw new ReturnError("Return already archived", 400);
    if (ret.status !== RETURN_STATUSES.DRAFT) {
      throw new ReturnError("Only draft returns can be archived", 400);
    }

    const updated = await tx.returnOrder.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        deletedBy: user.userId,
        version: { increment: 1 },
        statusHistory: {
          create: {
            fromStatus: ret.status,
            toStatus: ret.status,
            changedBy: user.userId,
            note: "Return archived",
            ip: meta.ip,
            userAgent: meta.userAgent,
            changedFields: ["deletedAt", "deletedBy", "version"],
            beforeState: JSON.parse(JSON.stringify({ status: ret.status, version: ret.version })),
            afterState: JSON.parse(JSON.stringify({ status: ret.status, version: ret.version + 1, archived: true })),
          },
        },
      },
    });

    await tx.notification.create({
      data: {
        userId: user.userId,
        type: "return_archived",
        title: "تمت أرشفة المرتجع",
        message: `تمت أرشفة المرتجع ${ret.returnNumber}`,
        entityType: "return_order",
        entityId: ret.id,
        referenceType: "returns",
        referenceId: ret.id,
        priority: "low",
        icon: "Archive",
        createdBySystem: true,
      },
    });

    return getReturnFull(tx, updated.id);
  });
}

// ─── Read ─────────────────────────────────────────────────────────────────────

export async function listReturns(
  client: PrismaClient,
  filters: {
    status?: string;
    type?: string;
    search?: string;
    from?: string;
    to?: string;
    page?: number;
    limit?: number;
  }
) {
  const page = Number(filters.page) || 1;
  const limit = Number(filters.limit) || 20;
  const where: Prisma.ReturnOrderWhereInput = { deletedAt: null };

  if (filters.status && filters.status !== "all") {
    const statuses = String(filters.status).split(",").map((s) => s.trim()).filter(Boolean);
    where.status = statuses.length === 1 ? statuses[0] : { in: statuses };
  }
  if (filters.type && filters.type !== "all") where.type = filters.type;
  if (filters.search) {
    where.OR = [
      { returnNumber: { contains: filters.search } },
      { sourceNumber: { contains: filters.search, mode: "insensitive" } },
      { partyName: { contains: filters.search, mode: "insensitive" } },
    ];
  }
  if (filters.from || filters.to) {
    where.createdAt = {};
    if (filters.from) where.createdAt.gte = new Date(filters.from);
    if (filters.to) where.createdAt.lte = new Date(filters.to);
  }

  const [returns, total] = await Promise.all([
    client.returnOrder.findMany({
      where,
      include: {
        items: { include: { product: { select: { id: true, name: true, sku: true } } } },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    client.returnOrder.count({ where }),
  ]);

  return {
    returns,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export async function getReturn(client: PrismaClient, id: string) {
  return runTx(client, async (tx) => getReturnFull(tx, id));
}

// ─── Source items for the creation form ──────────────────────────────────────

export async function getEligibleSourceItems(
  client: PrismaClient,
  opts: { type: string; sourceType: string; sourceId: string }
) {
  const { max, sourceNumber, partyId, partyName } = await getSourceCapacity(client as any, opts.sourceType, opts.sourceId);

  let items: Array<{ productId: string; productName: string; productSku: string | null; unit: string; maxReturnable: number; sourceItemId?: string }> = [];

  if (opts.sourceType === SOURCE_TYPES.SALES_ORDER) {
    const order = await client.salesOrder.findUnique({
      where: { id: opts.sourceId },
      include: { items: { include: { product: { select: { id: true, name: true, sku: true, unit: true } } } } },
    });
    items = (order?.items || [])
      .filter((i) => (max.get(i.productId) || 0) > 0)
      .map((i) => ({
        productId: i.productId,
        productName: i.product?.name || i.productName || "",
        productSku: i.product?.sku || i.productSku || null,
        unit: i.product?.unit || i.unit || "قطعة",
        maxReturnable: max.get(i.productId) || 0,
        sourceItemId: i.id,
      }));
  } else if (opts.sourceType === SOURCE_TYPES.PURCHASE_ORDER) {
    const po = await client.purchaseOrder.findUnique({
      where: { id: opts.sourceId },
      include: { items: { include: { product: { select: { id: true, name: true, sku: true, unit: true } } } } },
    });
    items = (po?.items || [])
      .filter((i) => (max.get(i.productId) || 0) > 0)
      .map((i) => ({
        productId: i.productId,
        productName: i.product?.name || "",
        productSku: i.product?.sku || null,
        unit: i.product?.unit || "قطعة",
        maxReturnable: max.get(i.productId) || 0,
        sourceItemId: i.id,
      }));
  } else if (opts.sourceType === SOURCE_TYPES.WITHDRAWAL) {
    const permit = await client.withdrawalPermit.findUnique({
      where: { id: opts.sourceId },
      include: { items: { include: { product: { select: { id: true, name: true, sku: true, unit: true } } } } },
    });
    items = (permit?.items || [])
      .filter((i) => (max.get(i.productId) || 0) > 0)
      .map((i) => ({
        productId: i.productId,
        productName: i.product?.name || "",
        productSku: i.product?.sku || null,
        unit: i.product?.unit || "قطعة",
        maxReturnable: max.get(i.productId) || 0,
        sourceItemId: i.id,
      }));
  } else if (opts.sourceType === SOURCE_TYPES.DELIVERY) {
    const delivery = await client.salesDelivery.findUnique({
      where: { id: opts.sourceId },
      include: { items: { include: { product: { select: { id: true, name: true, sku: true, unit: true } } } } },
    });
    items = (delivery?.items || [])
      .filter((i) => (max.get(i.productId) || 0) > 0)
      .map((i) => ({
        productId: i.productId,
        productName: i.product?.name || "",
        productSku: i.product?.sku || null,
        unit: i.product?.unit || "قطعة",
        maxReturnable: max.get(i.productId) || 0,
        sourceItemId: i.id,
      }));
  }

  return { source: { sourceType: opts.sourceType, sourceId: opts.sourceId, sourceNumber, partyId, partyName }, items };
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

export async function getReturnsDashboard(client: PrismaClient, filters: { from?: string; to?: string }) {
  const dateFilter: Prisma.ReturnOrderWhereInput = { deletedAt: null };
  if (filters.from || filters.to) {
    dateFilter.createdAt = {};
    if (filters.from) dateFilter.createdAt.gte = new Date(filters.from);
    if (filters.to) dateFilter.createdAt.lte = new Date(filters.to);
  }

  const activeReturns = await client.returnOrder.findMany({
    where: { deletedAt: null },
    select: { status: true, type: true, refundStatus: true, refundAmount: true, refundDate: true, items: { select: { productId: true, reason: true, receivedQty: true } } },
  });

  const periodReturns = await client.returnOrder.findMany({
    where: { ...dateFilter, status: { in: [RETURN_STATUSES.RECEIVED, RETURN_STATUSES.CLOSED] } },
    select: { type: true, partyName: true, partyId: true, items: { select: { productId: true, receivedQty: true, reason: true, product: { select: { name: true } } } } },
  });

  const byStatus = Object.values(RETURN_STATUSES).map((s) => ({
    status: s,
    count: activeReturns.filter((r) => r.status === s).length,
  }));

  const byType = Object.values(RETURN_TYPES).map((t) => ({
    type: t,
    count: activeReturns.filter((r) => r.type === t).length,
  }));

  const reasons = new Map<string, number>();
  for (const r of periodReturns) {
    for (const it of r.items) {
      if (it.receivedQty > 0) reasons.set(it.reason, (reasons.get(it.reason) || 0) + 1);
    }
  }
  const topReasons = [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([reason, count]) => ({ reason, count }));

  const productCounts = new Map<string, { productId: string; productName: string; qty: number }>();
  for (const r of periodReturns) {
    if (r.type !== RETURN_TYPES.CUSTOMER) continue;
    for (const it of r.items) {
      if (it.receivedQty <= 0) continue;
      const prev = productCounts.get(it.productId) || { productId: it.productId, productName: (it as any).product?.name || "", qty: 0 };
      prev.qty += it.receivedQty;
      productCounts.set(it.productId, prev);
    }
  }
  const mostReturnedProducts = [...productCounts.values()].sort((a, b) => b.qty - a.qty).slice(0, 5);

  const supplierCounts = new Map<string, { partyId: string; partyName: string; qty: number }>();
  for (const r of periodReturns) {
    if (r.type !== RETURN_TYPES.SUPPLIER) continue;
    const qty = r.items.reduce((s, it) => s + it.receivedQty, 0);
    const key = r.partyId || r.partyName || "unknown";
    const prev = supplierCounts.get(key) || { partyId: r.partyId || "", partyName: r.partyName || "", qty: 0 };
    prev.qty += qty;
    supplierCounts.set(key, prev);
  }
  const mostReturnedSuppliers = [...supplierCounts.values()].sort((a, b) => b.qty - a.qty).slice(0, 5);

  const refundWaiting = activeReturns.filter((r) => r.refundStatus === REFUND_STATUSES.PENDING || r.refundStatus === REFUND_STATUSES.PARTIAL);
  const refundWaitingTotal = refundWaiting.reduce((s, r) => s + (Number(r.refundAmount) || 0), 0);

  const returnedQty = periodReturns
    .filter((r) => r.type === RETURN_TYPES.CUSTOMER)
    .reduce((s, r) => s + r.items.reduce((x, it) => x + it.receivedQty, 0), 0);

  const soldQty = await client.inventoryLog.aggregate({
    where: {
      type: "sale",
      ...(filters.from || filters.to
        ? {
            createdAt: {
              ...(filters.from ? { gte: new Date(filters.from) } : {}),
              ...(filters.to ? { lte: new Date(filters.to) } : {}),
            },
          }
        : {}),
    },
    _sum: { change: true },
  });
  const deliveredQty = Math.abs(soldQty._sum?.change || 0);
  const returnRate = deliveredQty > 0 ? Math.round((returnedQty / deliveredQty) * 10000) / 100 : 0;

  const quarantine = await client.product.aggregate({ _sum: { quarantineStock: true } });

  return {
    returnRate,
    returnedQty,
    deliveredQty,
    mostReturnedProducts,
    mostReturnedSuppliers,
    topReasons,
    refundWaiting: { count: refundWaiting.length, total: round2(refundWaitingTotal) },
    byStatus,
    byType,
    quarantineVolume: quarantine._sum.quarantineStock || 0,
  };
}

// ─── Refund delay detection (like expireSalesOrders) ─────────────────────────

export async function checkRefundDelays(client: PrismaClient): Promise<number> {
  const overdue = await client.returnOrder.findMany({
    where: {
      deletedAt: null,
      refundStatus: { in: [REFUND_STATUSES.PENDING, REFUND_STATUSES.PARTIAL] },
      refundDueAt: { lte: new Date() },
    },
    select: { id: true, returnNumber: true, refundAmount: true, createdBy: true, refundStatus: true },
  });

  let count = 0;
  for (const ret of overdue) {
    const existing = await client.notification.findFirst({
      where: { type: "return_refund_delayed", entityId: ret.id, deletedAt: null },
    });
    if (existing) continue;

    const owners = await getActiveOwners(client as any);
    const recipients = new Set<string>([ret.createdBy || ""].filter(Boolean));
    for (const o of owners) recipients.add(o.id);

    for (const recipientId of recipients) {
      await client.notification.create({
        data: {
          userId: recipientId,
          type: "return_refund_delayed",
          title: "تأخر الـ Refund",
          message: `المرتجع ${ret.returnNumber} تأخر Refund (${Number(ret.refundAmount) || 0} EGP — ${ret.refundStatus})`,
          entityType: "return_order",
          entityId: ret.id,
          referenceType: "returns",
          referenceId: ret.id,
          priority: "urgent",
          icon: "AlarmClock",
          createdBySystem: true,
        },
      });
    }
    count++;
  }
  return count;
}

// ─── Sales Orders integration (Returned / Net Sold) ──────────────────────────

export async function getReturnedQtyBySource(
  client: PrismaClient,
  sourceType: string,
  sourceId: string
): Promise<Map<string, number>> {
  const returns = await client.returnOrder.findMany({
    where: {
      sourceType,
      sourceId,
      deletedAt: null,
      status: { in: [RETURN_STATUSES.RECEIVED, RETURN_STATUSES.CLOSED] },
    },
    select: { items: { select: { productId: true, receivedQty: true } } },
  });
  const map = new Map<string, number>();
  for (const ret of returns) {
    for (const it of ret.items) {
      map.set(it.productId, (map.get(it.productId) || 0) + it.receivedQty);
    }
  }
  return map;
}
