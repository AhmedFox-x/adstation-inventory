import { Prisma, PrismaClient } from "@prisma/client";
import { getReturnedQtyBySource } from "./returnsService";
import { createNotification, createNotifications } from "./notificationService";
import { getDefaultWarehouseId, decrementWarehouseStock, decrementReservedStock, incrementReservedStock } from "../utils/stockSync";

type Tx = Prisma.TransactionClient;

export interface ServiceUser {
  userId: string;
  name?: string;
  role?: string;
}

export interface RequestMeta {
  ip?: string;
  userAgent?: string;
}

export interface OrderItemInput {
  productId: string;
  orderedQty: number;
  sellingPrice: number;
  discount?: number;
  tax?: number;
  listPrice?: number;
  listTier?: string;
}

export interface CreateOrderInput {
  clientId: string;
  reference?: string;
  expectedDeliveryDate?: string;
  expiresAt?: string;
  notes?: string;
  items: OrderItemInput[];
}

export interface UpdateOrderInput extends CreateOrderInput {
  expectedVersion?: number;
}

export interface DeliverItemInput {
  itemId: string;
  deliveredQty: number;
}

export interface DeliverInput {
  deliveredItems: DeliverItemInput[];
  notes?: string;
  driverName?: string;
  vehicle?: string;
  proofImage?: string;
  signature?: string;
  gpsLocation?: string;
}

export const VALID_TRANSITIONS: Record<string, string[]> = {
  draft: ["confirmed", "cancelled"],
  confirmed: ["processing", "cancelled"],
  processing: ["shipped", "cancelled"],
  shipped: ["delivered", "partially_delivered", "cancelled"],
  partially_delivered: ["delivered", "cancelled"],
  delivered: ["closed"],
  cancelled: [],
  closed: [],
};

export class SalesOrderError extends Error {
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

const DEFAULT_APPROVAL_THRESHOLD = { value: 5000, currency: "EGP" };

async function getApprovalThreshold(tx: Tx): Promise<{ value: number; currency: string }> {
  const [vRow, cRow] = await Promise.all([
    tx.systemSettings.findUnique({ where: { key: "approvalThresholdValue" } }),
    tx.systemSettings.findUnique({ where: { key: "approvalThresholdCurrency" } }),
  ]);
  const value = vRow && vRow.value !== "" && !Number.isNaN(Number(vRow.value)) ? Number(vRow.value) : null;
  if (value === null || !cRow) {
    console.warn(
      `[approval] SystemSettings threshold missing/invalid (value=${vRow?.value ?? "?"}, currency=${cRow?.value ?? "?"}) — using default ${DEFAULT_APPROVAL_THRESHOLD.value} ${DEFAULT_APPROVAL_THRESHOLD.currency}. Run db:seed to persist.`
    );
  }
  return {
    value: value ?? DEFAULT_APPROVAL_THRESHOLD.value,
    currency: cRow?.value || DEFAULT_APPROVAL_THRESHOLD.currency,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function calcItemTotals(input: OrderItemInput) {
  const qty = Number(input.orderedQty) || 0;
  const price = Number(input.sellingPrice) || 0;
  const discountRate = Number(input.discount) || 0;
  const taxRate = Number(input.tax) || 0;
  const subtotal = round2(price * qty);
  const discountAmount = round2(subtotal * (discountRate / 100));
  const afterDiscount = round2(subtotal - discountAmount);
  const taxAmount = round2(afterDiscount * (taxRate / 100));
  const totalPrice = round2(afterDiscount + taxAmount);
  return { subtotal, discountAmount, taxAmount, totalPrice, discountRate, taxRate };
}

function calcOrderTotals(items: OrderItemInput[]) {
  let subtotal = 0;
  let discount = 0;
  let taxAmount = 0;
  let grandTotal = 0;
  for (const i of items) {
    const r = calcItemTotals(i);
    subtotal += r.subtotal;
    discount += r.discountAmount;
    taxAmount += r.taxAmount;
    grandTotal += r.totalPrice;
  }
  return {
    subtotal: round2(subtotal),
    discount: round2(discount),
    taxAmount: round2(taxAmount),
    grandTotal: round2(grandTotal),
  };
}

async function generateOrderNumber(tx: Tx): Promise<string> {
  const now = new Date();
  const ym = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;
  const prefix = `SO-${ym}-`;
  const last = await tx.salesOrder.findFirst({
    where: { orderNumber: { startsWith: prefix } },
    orderBy: { orderNumber: "desc" },
    select: { orderNumber: true },
  });
  const next = last ? Number(last.orderNumber.slice(prefix.length)) + 1 : 1;
  return `${prefix}${String(next).padStart(6, "0")}`;
}

async function generateDeliveryNumber(tx: Tx): Promise<string> {
  const now = new Date();
  const ym = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;
  const prefix = `SD-${ym}-`;
  const last = await tx.salesDelivery.findFirst({
    where: { deliveryNumber: { startsWith: prefix } },
    orderBy: { deliveryNumber: "desc" },
    select: { deliveryNumber: true },
  });
  const next = last ? Number(last.deliveryNumber.slice(prefix.length)) + 1 : 1;
  return `${prefix}${String(next).padStart(6, "0")}`;
}

async function computeMovingAverageCost(tx: Tx, productId: string): Promise<number> {
  const product = await tx.product.findUnique({
    where: { id: productId },
    select: { costPrice: true },
  });
  return product?.costPrice ?? 0;
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

async function getClientName(tx: Tx, clientId: string): Promise<string> {
  const c = await tx.client.findUnique({ where: { id: clientId }, select: { name: true } });
  return c?.name || "";
}

async function getOrderFull(tx: Tx, id: string) {
  return tx.salesOrder.findUnique({
    where: { id },
    include: {
      client: { select: { id: true, name: true } },
      items: { orderBy: { id: "asc" }, include: { product: { select: { id: true, name: true, stock: true, reservedStock: true, minStock: true } } } },
      statusHistory: { orderBy: { createdAt: "asc" } },
      approvals: { orderBy: { createdAt: "asc" } },
      deliveries: { include: { items: true } },
    },
  });
}

async function requireOrderFull(tx: Tx, id: string) {
  const order = await getOrderFull(tx, id);
  if (!order) throw new SalesOrderError("Sales order not found", 404);
  return decorateApproval(order);
}

// ─── Approval projection (Phase 3) ───────────────────────────────────────────
// SalesOrderApproval هو الـ source of truth — approvalStatus/rejectionNote
// بتتقري من آخر قرار مش superseded من غير أي حقل إضافي في SalesOrder.
function decorateApproval(order: any) {
  const approvals = Array.isArray(order.approvals)
    ? [...order.approvals].sort(
        (a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      )
    : [];
  const latest = approvals.find((a: any) => a.status !== "superseded");
  const status = latest ? latest.status : "none";
  order.approvalStatus = status;
  order.rejectionNote = status === "rejected" ? latest.reason || null : null;
  return order;
}

function snapshotProduct(product: any) {
  return {
    productName: product.name,
    productSku: product.sku || null,
    unit: product.unit || "قطعة",
    barcode: product.barcode || null,
    category: product.category || null,
    brand: product.brand || null,
  };
}

// ─── Public functions ─────────────────────────────────────────────────────────

export async function createOrder(client: PrismaClient, input: CreateOrderInput, user: ServiceUser, meta: RequestMeta = {}) {
  if (!input.clientId) throw new SalesOrderError("clientId is required", 400);
  if (!Array.isArray(input.items) || input.items.length === 0) throw new SalesOrderError("items is required", 400);
  for (const it of input.items) {
    if (!it.productId) throw new SalesOrderError("item productId is required", 400);
    if (!Number(it.orderedQty) || Number(it.orderedQty) <= 0) throw new SalesOrderError("item orderedQty must be positive", 400);
    if (!Number(it.sellingPrice) || Number(it.sellingPrice) < 0) throw new SalesOrderError("item sellingPrice is required", 400);
  }

  const totals = calcOrderTotals(input.items);

  return runTx(client, async (tx) => {
    const orderNumber = await generateOrderNumber(tx);
    const products = await tx.product.findMany({ where: { id: { in: input.items.map((i) => i.productId) }, deletedAt: null } });
    const productMap = new Map(products.map((p) => [p.id, p]));
    for (const it of input.items) {
      if (!productMap.has(it.productId)) throw new SalesOrderError(`Product not found: ${it.productId}`, 404);
    }
    const clientName = await getClientName(tx, input.clientId);

    const stockWarnings: string[] = [];
    for (const it of input.items) {
      const p = productMap.get(it.productId)!;
      const available = (p.stock ?? 0) - (p.reservedStock ?? 0);
      const qty = Number(it.orderedQty);
      if (qty > available) {
        stockWarnings.push(`${p.name}: available ${available}, ordered ${qty}`);
      }
    }
    if (stockWarnings.length > 0) {
      throw new SalesOrderError(`Insufficient stock: ${stockWarnings.join('; ')}`, 409);
    }

    const order = await tx.salesOrder.create({
      data: {
        orderNumber,
        clientId: input.clientId,
        reference: input.reference || null,
        expectedDeliveryDate: input.expectedDeliveryDate ? new Date(input.expectedDeliveryDate) : null,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        notes: input.notes || null,
        subtotal: totals.subtotal,
        discount: totals.discount,
        taxAmount: totals.taxAmount,
        grandTotal: totals.grandTotal,
        createdBy: user.userId,
        statusHistory: {
          create: {
            toStatus: "draft",
            changedBy: user.userId,
            ip: meta.ip,
            userAgent: meta.userAgent,
            changedFields: ["created"],
          },
        },
        items: {
          create: input.items.map((it) => {
            const r = calcItemTotals(it);
            const p = productMap.get(it.productId)!;
            return {
              productId: it.productId,
              orderedQty: Number(it.orderedQty),
              deliveredQty: 0,
              sellingPrice: Number(it.sellingPrice),
              listPrice: it.listPrice ?? null,
              listTier: it.listTier ?? null,
              costPrice: 0,
              discountRate: r.discountRate,
              taxRate: r.taxRate,
              discount: r.discountAmount,
              tax: r.taxAmount,
              totalPrice: r.totalPrice,
              currency: "EGP",
              exchangeRate: 1,
              ...snapshotProduct(p),
            };
          }),
        },
      },
      include: { items: true, client: { select: { id: true, name: true } } },
    });

    return requireOrderFull(tx, order.id);
  });
}

export async function updateOrder(client: PrismaClient, id: string, input: UpdateOrderInput, user: ServiceUser, meta: RequestMeta = {}) {
  if (!input.clientId) throw new SalesOrderError("clientId is required", 400);
  if (!Array.isArray(input.items) || input.items.length === 0) throw new SalesOrderError("items is required", 400);

  const totals = calcOrderTotals(input.items);

  return runTx(client, async (tx) => {
    const existing = await tx.salesOrder.findUnique({ where: { id }, include: { items: true } });
    if (!existing) throw new SalesOrderError("Sales order not found", 404);
    if (existing.deletedAt) throw new SalesOrderError("Sales order not found", 404);
    if (existing.status !== "draft") throw new SalesOrderError("Only draft orders can be edited", 400);

    const expectedVersion = input.expectedVersion ?? existing.version;
    if (expectedVersion !== existing.version) {
      throw new SalesOrderError("Order was modified by another user. Refresh and retry.", 409);
    }

    const products = await tx.product.findMany({ where: { id: { in: input.items.map((i) => i.productId) }, deletedAt: null } });
    const productMap = new Map(products.map((p) => [p.id, p]));
    for (const it of input.items) {
      if (!productMap.has(it.productId)) throw new SalesOrderError(`Product not found: ${it.productId}`, 404);
    }
    const clientName = await getClientName(tx, input.clientId);

    const stockWarnings: string[] = [];
    for (const it of input.items) {
      const p = productMap.get(it.productId)!;
      const available = (p.stock ?? 0) - (p.reservedStock ?? 0);
      const qty = Number(it.orderedQty);
      if (qty > available) {
        stockWarnings.push(`${p.name}: available ${available}, ordered ${qty}`);
      }
    }
    if (stockWarnings.length > 0) {
      throw new SalesOrderError(`Insufficient stock: ${stockWarnings.join('; ')}`, 409);
    }

    await tx.salesOrderItem.deleteMany({ where: { orderId: id } });

    const updated = await tx.salesOrder.update({
      where: { id },
      data: {
        clientId: input.clientId,
        reference: input.reference || null,
        expectedDeliveryDate: input.expectedDeliveryDate ? new Date(input.expectedDeliveryDate) : null,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        notes: input.notes || null,
        subtotal: totals.subtotal,
        discount: totals.discount,
        taxAmount: totals.taxAmount,
        grandTotal: totals.grandTotal,
        version: { increment: 1 },
        statusHistory: {
          create: {
            toStatus: "draft",
            changedBy: user.userId,
            note: "Order edited",
            ip: meta.ip,
            userAgent: meta.userAgent,
            changedFields: ["items", "subtotal", "grandTotal", "version"],
          },
        },
        items: {
          create: input.items.map((it) => {
            const r = calcItemTotals(it);
            const p = productMap.get(it.productId)!;
            return {
              productId: it.productId,
              orderedQty: Number(it.orderedQty),
              deliveredQty: 0,
              sellingPrice: Number(it.sellingPrice),
              listPrice: it.listPrice ?? null,
              listTier: it.listTier ?? null,
              costPrice: 0,
              discountRate: r.discountRate,
              taxRate: r.taxRate,
              discount: r.discountAmount,
              tax: r.taxAmount,
              totalPrice: r.totalPrice,
              currency: "EGP",
              exchangeRate: 1,
              ...snapshotProduct(p),
            };
          }),
        },
      },
    });

    // Void stale approvals — المحتوى اتغيّر، القرارات القديمة (pending/rejected)
    // مبقتش سارية. من غير حذف — الـ history يفضل append-only.
    const staleApprovals = await tx.salesOrderApproval.findMany({
      where: { salesOrderId: id, status: { in: ["pending", "rejected"] } },
    });
    for (const stale of staleApprovals) {
      await tx.salesOrderApproval.update({
        where: { id: stale.id },
        data: { status: "superseded" },
      });
    }

    return requireOrderFull(tx, updated.id);
  });
}

// ─── Confirm logic (shared between confirm and approve) ───────────────────────

async function executeConfirmedTransition(
  tx: Tx,
  orderId: string,
  user: ServiceUser,
  meta: RequestMeta,
  approvalId?: string
) {
  const order = await tx.salesOrder.findUnique({ where: { id: orderId }, include: { items: true, client: true } });
  if (!order) throw new SalesOrderError("Sales order not found", 404);

  const productIds = order.items.map((i) => i.productId);
  await lockProducts(tx, productIds);

  // Re-read fresh after acquiring row locks — protects against double reserve
  const fresh = await tx.salesOrder.findUnique({ where: { id: orderId }, include: { items: true, client: true } });
  if (!fresh) throw new SalesOrderError("Sales order not found", 404);
  if (fresh.status !== "draft") throw new SalesOrderError(`Cannot confirm order in status ${fresh.status}`, 409);

  const products = await tx.product.findMany({ where: { id: { in: productIds }, deletedAt: null } });
  const productMap = new Map(products.map((p) => [p.id, p]));

  for (const item of fresh.items) {
    const product = productMap.get(item.productId);
    if (!product) throw new SalesOrderError(`Product not found: ${item.productId}`, 404);
    const available = product.stock - product.reservedStock;
    if (item.orderedQty > available) {
      throw new SalesOrderError(
        `Insufficient stock for ${product.name}: available ${available}, required ${item.orderedQty}`,
        409
      );
    }
  }

  const defaultWarehouse = await tx.warehouse.findFirst({ where: { isActive: true }, orderBy: { createdAt: "asc" } });
  const reservationWarehouseId = defaultWarehouse?.id;
  if (!reservationWarehouseId) throw new SalesOrderError("No active warehouse found for reservation", 400);

  // ── Profitability accumulation ─────────────────────────────────────────
  // Per project decision: if ANY item has missing/invalid cost, order-level
  // profitability is marked incomplete (null), never a fabricated 0.
  let orderProfitTotal = 0
  let orderRevenueTotal = 0
  let orderProfitIncomplete = false

  for (const item of fresh.items) {
    const product = productMap.get(item.productId)!;
    const costPrice = await computeMovingAverageCost(tx, item.productId);
    await tx.product.update({
      where: { id: item.productId },
      data: { reservedStock: { increment: item.orderedQty } },
    });
    // Sync WarehouseStock reservedQuantity
    await incrementReservedStock(tx, reservationWarehouseId, item.productId, item.orderedQty);

    // Cost valid? → compute grossProfit + margin per item; else mark incomplete
    const sellingPrice = item.sellingPrice ?? 0
    const qty = item.orderedQty || 0
    let grossProfit: number | null = null
    let marginPct: number | null = null
    if (costPrice !== null && costPrice > 0) {
      grossProfit = costPrice > 0 ? Math.round((sellingPrice - costPrice) * qty * 100) / 100 : null
      marginPct = costPrice > 0 ? Math.round((((sellingPrice - costPrice) / costPrice) * 100) * 100) / 100 : null
    } else {
      orderProfitIncomplete = true
    }
    if (grossProfit !== null) orderProfitTotal += grossProfit
    else orderProfitIncomplete = true
    orderRevenueTotal += sellingPrice * qty

    await tx.salesOrderItem.update({
      where: { id: item.id },
      data: { costPrice, grossProfit, marginPct },
    });
    await tx.inventoryLog.create({
      data: {
        type: "reservation",
        productId: item.productId,
        oldStock: product.stock,
        newStock: product.stock,
        change: -item.orderedQty,
        clientName: fresh.client?.name || "",
        salesName: user.name || "",
        notes: `حجز ${item.orderedQty} وحدة من ${product.name} للطلب ${order.orderNumber}`,
        referenceType: "sales_order",
        referenceId: order.id,
        userId: user.userId,
        userName: user.name,
        userRole: user.role,
        entityType: "sales_order",
        entityId: order.id,
        beforeData: { stock: product.stock, reservedStock: product.reservedStock },
        afterData: { stock: product.stock, reservedStock: (product.reservedStock ?? 0) + item.orderedQty },
      },
    });
    await tx.reservation.create({
      data: {
        productId: item.productId,
        clientId: fresh.clientId,
        salesOrderItemId: item.id,
        warehouseId: reservationWarehouseId,
        quantity: item.orderedQty,
        fulfilledQty: 0,
        status: "active",
        notes: `حجز تلقائي للطلب ${order.orderNumber}`,
        expiresAt: order.expiresAt,
        createdBy: user.userId,
      },
    });
  }

  const updateData: Prisma.SalesOrderUpdateInput = {
    status: "confirmed",
    version: { increment: 1 },
    totalProfit: orderProfitIncomplete ? null : Math.round(orderProfitTotal * 100) / 100,
    totalMarginPct: (orderProfitIncomplete || orderRevenueTotal === 0)
      ? null
      : Math.round((orderProfitTotal / orderRevenueTotal) * 100 * 100) / 100,
  };
  if (approvalId) {
    updateData.approvals = {
      update: {
        where: { id: approvalId },
        data: { status: "approved", approvedBy: user.userId, approvedAt: new Date() },
      },
    };
  }

  await tx.salesOrder.update({ where: { id: orderId }, data: updateData });

  await tx.salesOrderStatusHistory.create({
    data: {
      orderId,
      fromStatus: "draft",
      toStatus: "confirmed",
      changedBy: user.userId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      changedFields: ["status", "reservedStock", "costPrice", "version"],
      beforeState: JSON.parse(JSON.stringify({ status: fresh.status, version: fresh.version })),
      afterState: JSON.parse(JSON.stringify({ status: "confirmed", version: fresh.version + 1 })),
    },
  });

  if (!approvalId) {
    await createNotification(tx, {
      userId: fresh.createdBy || user.userId,
      type: "order_confirmed",
      title: "تم تأكيد الطلب",
      message: `تم تأكيد الطلب ${order.orderNumber} للعميل ${fresh.client?.name || ""}`,
      entityType: "sales_order",
      entityId: order.id,
      referenceType: "sales_order",
      referenceId: order.id,
      priority: "normal",
    });
  } else {
    await createNotification(tx, {
      userId: fresh.createdBy || user.userId,
      type: "order_approved",
      title: "تم اعتماد الطلب",
      message: `تم اعتماد الطلب ${order.orderNumber}`,
      entityType: "sales_order",
      entityId: order.id,
      referenceType: "sales_order",
      referenceId: order.id,
      priority: "high",
    });
  }

  return requireOrderFull(tx, orderId);
}

export async function confirmOrder(client: PrismaClient, id: string, user: ServiceUser, meta: RequestMeta = {}) {
  await expireSalesOrders(client);

  return runTx(client, async (tx) => {
    const order = await tx.salesOrder.findUnique({
      where: { id },
      include: { client: true, approvals: { orderBy: { createdAt: "desc" }, take: 1 } },
    });
    if (!order) throw new SalesOrderError("Sales order not found", 404);
    if (order.deletedAt) throw new SalesOrderError("Sales order not found", 404);
    if (order.status !== "draft") throw new SalesOrderError(`Cannot confirm order in status ${order.status}`, 409);

    const latestApproval = order.approvals?.[0];
    if (latestApproval?.status === "pending") {
      throw new SalesOrderError("Order already pending approval", 409);
    }
    if (latestApproval?.status === "rejected") {
      throw new SalesOrderError("Order was rejected. Edit the order before confirming again.", 409);
    }

    const threshold = await getApprovalThreshold(tx);
    const grandTotal = Number(order.grandTotal) || 0;
    const sameCurrency = (order.currency || "EGP") === threshold.currency;

    if (!sameCurrency || grandTotal > threshold.value) {
      const approval = await tx.salesOrderApproval.create({
        data: {
          salesOrderId: order.id,
          status: "pending",
          requestedBy: user.userId,
        },
      });
      await tx.salesOrderStatusHistory.create({
        data: {
          orderId: order.id,
          fromStatus: "draft",
          toStatus: "draft",
          changedBy: user.userId,
          note: `Approval requested (grandTotal ${grandTotal} ${order.currency || "EGP"})`,
          ip: meta.ip,
          userAgent: meta.userAgent,
          changedFields: ["approval"],
          beforeState: JSON.parse(JSON.stringify({ status: order.status, version: order.version })),
          afterState: JSON.parse(JSON.stringify({ status: order.status, version: order.version, approval: approval.id })),
        },
      });
      const owners = await getActiveOwners(tx);
      await createNotifications(
        tx,
        owners.map((o) => o.id),
        {
          type: "approval_needed",
          title: "طلب يحتاج اعتماد",
          message: `الطلب ${order.orderNumber} من ${order.client?.name || ""} يحتاج اعتماد (قيمته ${grandTotal} ${order.currency || "EGP"})`,
          entityType: "sales_order",
          entityId: order.id,
          referenceType: "sales_order",
          referenceId: order.id,
          priority: "high",
        }
      );
      return requireOrderFull(tx, order.id);
    }

    return executeConfirmedTransition(tx, order.id, user, meta);
  });
}

export async function approveOrder(client: PrismaClient, id: string, user: ServiceUser, meta: RequestMeta = {}, note?: string) {
  return runTx(client, async (tx) => {
    const order = await tx.salesOrder.findUnique({
      where: { id },
      include: { approvals: { where: { status: "pending" }, orderBy: { createdAt: "desc" }, take: 1 } },
    });
    if (!order) throw new SalesOrderError("Sales order not found", 404);
    const approval = order.approvals?.[0];
    if (!approval) throw new SalesOrderError("No pending approval for this order", 400);

    return executeConfirmedTransition(tx, id, user, meta, approval.id);
  });
}

export async function rejectOrder(client: PrismaClient, id: string, user: ServiceUser, meta: RequestMeta = {}, reason?: string) {
  if (!reason || !reason.trim()) throw new SalesOrderError("reason is required", 400);

  return runTx(client, async (tx) => {
    const order = await tx.salesOrder.findUnique({
      where: { id },
      include: { client: true, approvals: { where: { status: "pending" }, orderBy: { createdAt: "desc" }, take: 1 } },
    });
    if (!order) throw new SalesOrderError("Sales order not found", 404);
    const approval = order.approvals?.[0];
    if (!approval) throw new SalesOrderError("No pending approval for this order", 400);

    await tx.salesOrderApproval.update({
      where: { id: approval.id },
      data: { status: "rejected", rejectedBy: user.userId, rejectedAt: new Date(), reason },
    });

    await tx.salesOrderStatusHistory.create({
      data: {
        orderId: id,
        fromStatus: "draft",
        toStatus: "draft",
        changedBy: user.userId,
        note: `Order rejected: ${reason}`,
        ip: meta.ip,
        userAgent: meta.userAgent,
        changedFields: ["approval"],
        beforeState: JSON.parse(JSON.stringify({ status: order.status, version: order.version })),
        afterState: JSON.parse(JSON.stringify({ status: order.status, version: order.version, approval: approval.id })),
      },
    });

    await createNotification(tx, {
      userId: order.createdBy || user.userId,
      type: "order_rejected",
      title: "تم رفض الطلب",
      message: `تم رفض الطلب ${order.orderNumber} — ${reason}`,
      entityType: "sales_order",
      entityId: order.id,
      referenceType: "sales_order",
      referenceId: order.id,
      priority: "urgent",
    });

    return requireOrderFull(tx, order.id);
  });
}

// ─── Simple transitions ───────────────────────────────────────────────────────

async function simpleTransition(client: PrismaClient, id: string, to: string, user: ServiceUser, meta: RequestMeta = {}) {
  await expireSalesOrders(client);

  return runTx(client, async (tx) => {
    const order = await tx.salesOrder.findUnique({ where: { id } });
    if (!order || order.deletedAt) throw new SalesOrderError("Sales order not found", 404);
    const valid = VALID_TRANSITIONS[order.status] || [];
    if (!valid.includes(to)) {
      throw new SalesOrderError(`Cannot transition from ${order.status} to ${to}`, 400);
    }
    const updated = await tx.salesOrder.update({
      where: { id },
      data: {
        status: to,
        version: { increment: 1 },
        statusHistory: {
          create: {
            fromStatus: order.status,
            toStatus: to,
            changedBy: user.userId,
            ip: meta.ip,
            userAgent: meta.userAgent,
            changedFields: ["status", "version"],
            beforeState: JSON.parse(JSON.stringify({ status: order.status, version: order.version })),
            afterState: JSON.parse(JSON.stringify({ status: to, version: order.version + 1 })),
          },
        },
      },
    });
    return requireOrderFull(tx, updated.id);
  });
}

export function transitionToProcessing(client: PrismaClient, id: string, user: ServiceUser, meta: RequestMeta = {}) {
  return simpleTransition(client, id, "processing", user, meta);
}

export function transitionToShipped(client: PrismaClient, id: string, user: ServiceUser, meta: RequestMeta = {}) {
  return simpleTransition(client, id, "shipped", user, meta);
}

export function transitionToClosed(client: PrismaClient, id: string, user: ServiceUser, meta: RequestMeta = {}) {
  return simpleTransition(client, id, "closed", user, meta);
}

// ─── Deliver ──────────────────────────────────────────────────────────────────

export async function deliverOrder(client: PrismaClient, id: string, input: DeliverInput, user: ServiceUser, meta: RequestMeta = {}) {
  await expireSalesOrders(client);

  if (!Array.isArray(input.deliveredItems) || input.deliveredItems.length === 0) {
    throw new SalesOrderError("deliveredItems is required", 400);
  }
  for (const di of input.deliveredItems) {
    if (!di.itemId || !Number(di.deliveredQty) || Number(di.deliveredQty) <= 0) {
      throw new SalesOrderError("Each deliveredItem must have itemId and positive deliveredQty", 400);
    }
  }

  return runTx(client, async (tx) => {
    const order = await tx.salesOrder.findUnique({
      where: { id },
      include: { items: true, client: true, approvals: { where: { status: "pending" }, take: 1 } },
    });
    if (!order || order.deletedAt) throw new SalesOrderError("Sales order not found", 404);

    if (order.approvals.length > 0) {
      throw new SalesOrderError("Order has a pending approval. It must be approved or rejected before delivery.", 403);
    }

    const productIds = order.items.map((i) => i.productId);
    await lockProducts(tx, productIds);

    // Re-read fresh after acquiring row locks — protects against double delivery
    const fresh = await tx.salesOrder.findUnique({
      where: { id },
      include: { items: true, client: true, approvals: { where: { status: "pending" }, take: 1 } },
    });
    if (!fresh || fresh.deletedAt) throw new SalesOrderError("Sales order not found", 404);
    if (fresh.approvals.length > 0) {
      throw new SalesOrderError("Order has a pending approval. It must be approved or rejected before delivery.", 403);
    }
    if (fresh.status !== "shipped" && fresh.status !== "partially_delivered") {
      throw new SalesOrderError(`Cannot deliver order in status ${fresh.status}`, 400);
    }

    const defaultWhId = await getDefaultWarehouseId(tx);
    const products = await tx.product.findMany({ where: { id: { in: productIds } } });
    const productMap = new Map(products.map((p) => [p.id, p]));

    const deliveryNumber = await generateDeliveryNumber(tx);
    const delivery = await tx.salesDelivery.create({
      data: {
        salesOrderId: id,
        deliveryNumber,
        deliveredBy: user.userId,
        driverName: input.driverName || null,
        vehicle: input.vehicle || null,
        proofImage: input.proofImage || null,
        signature: input.signature || null,
        gpsLocation: input.gpsLocation || null,
        notes: input.notes || null,
      },
    });

    const itemMap = new Map(fresh.items.map((i) => [i.id, i]));

    for (const di of input.deliveredItems) {
      const item = itemMap.get(di.itemId);
      if (!item) throw new SalesOrderError(`Item ${di.itemId} not found in order`, 404);
      const qty = Number(di.deliveredQty);
      const newDelivered = item.deliveredQty + qty;
      if (newDelivered > item.orderedQty) {
        throw new SalesOrderError(`Delivered qty exceeds ordered qty for item ${item.id}`, 400);
      }

      const product = productMap.get(item.productId);
      if (!product) throw new SalesOrderError(`Product not found: ${item.productId}`, 404);

      await tx.salesOrderItem.update({
        where: { id: item.id },
        data: { deliveredQty: newDelivered },
      });
      await tx.product.update({
        where: { id: item.productId },
        data: {
          stock: { decrement: qty },
          reservedStock: { decrement: qty },
        },
      });
      // Sync WarehouseStock
      await decrementWarehouseStock(tx, defaultWhId, item.productId, qty);
      await decrementReservedStock(tx, defaultWhId, item.productId, qty);
      await tx.salesDeliveryItem.create({
        data: {
          deliveryId: delivery.id,
          salesOrderItemId: item.id,
          productId: item.productId,
          quantity: qty,
          unit: item.unit || product.unit || "قطعة",
        },
      });

      const reservation = await tx.reservation.findFirst({
        where: { salesOrderItemId: item.id, status: "active" },
        orderBy: { createdAt: "asc" },
      });
      if (reservation) {
        const newFulfilled = reservation.fulfilledQty + qty;
        await tx.reservation.update({
          where: { id: reservation.id },
          data: {
            fulfilledQty: newFulfilled,
            status: newFulfilled >= reservation.quantity ? "fulfilled" : "active",
          },
        });
      }

      await tx.inventoryLog.create({
        data: {
          type: "sale",
          productId: item.productId,
          oldStock: product.stock,
          newStock: product.stock - qty,
          change: -qty,
          clientName: order.client?.name || "",
          salesName: user.name || "",
          notes: `صرف ${qty} وحدة من ${product.name} للتوصيل للطلب ${order.orderNumber}`,
          referenceType: "sales_order",
          referenceId: order.id,
          userId: user.userId,
          userName: user.name,
          userRole: user.role,
          entityType: "sales_order",
          entityId: order.id,
          beforeData: { stock: product.stock, reservedStock: product.reservedStock },
          afterData: { stock: product.stock - qty, reservedStock: (product.reservedStock ?? 0) - qty },
        },
      });
    }

    let newStatus: string;
    const refreshed = await tx.salesOrderItem.findMany({ where: { orderId: id } });
    const allDelivered = refreshed.every((i) => i.deliveredQty >= i.orderedQty);
    newStatus = allDelivered ? "delivered" : "partially_delivered";

    await tx.salesOrder.update({
      where: { id },
      data: {
        status: newStatus,
        actualDeliveryDate: new Date(),
        version: { increment: 1 },
        statusHistory: {
          create: {
            fromStatus: fresh.status,
            toStatus: newStatus,
            changedBy: user.userId,
            note: input.notes || null,
            ip: meta.ip,
            userAgent: meta.userAgent,
            changedFields: ["status", "deliveredQty", "stock", "reservedStock", "version"],
            beforeState: JSON.parse(JSON.stringify({ status: fresh.status, version: fresh.version })),
            afterState: JSON.parse(JSON.stringify({ status: newStatus, version: fresh.version + 1 })),
          },
        },
      },
    });

    await createNotification(tx, {
      userId: order.createdBy || user.userId,
      type: "order_delivered",
      title: "تم التوصيل",
      message: `تم توصيل الطلب ${order.orderNumber}`,
      entityType: "sales_order",
      entityId: order.id,
      referenceType: "sales_order",
      referenceId: order.id,
      priority: "normal",
    });

    for (const di of input.deliveredItems) {
      const item = itemMap.get(di.itemId)!;
      const product = productMap.get(item.productId)!;
      if (product.stock - Number(di.deliveredQty) <= product.minStock) {
        const recipients = new Set<string>([order.createdBy || user.userId]);
        const owners = await getActiveOwners(tx);
        for (const o of owners) recipients.add(o.id);
        await createNotifications(
          tx,
          [...recipients],
          {
            type: "low_stock",
            title: "مخزون منخفض",
            message: `المخزون من ${product.name} وصل ${product.stock - Number(di.deliveredQty)} (الحد الأدنى: ${product.minStock})`,
            entityType: "product",
            entityId: product.id,
            referenceType: "product",
            referenceId: product.id,
            priority: "urgent",
          }
        );
      }
    }

    return requireOrderFull(tx, id);
  });
}

// ─── Cancel ───────────────────────────────────────────────────────────────────

export async function cancelOrder(client: PrismaClient, id: string, user: ServiceUser, meta: RequestMeta = {}, note?: string) {
  return runTx(client, async (tx) => {
    const defaultWhId = await getDefaultWarehouseId(tx);
    const order = await tx.salesOrder.findUnique({ where: { id }, include: { items: true, client: true } });
    if (!order || order.deletedAt) throw new SalesOrderError("Sales order not found", 404);

    const valid = VALID_TRANSITIONS[order.status] || [];
    if (!valid.includes("cancelled")) throw new SalesOrderError(`Cannot cancel order in status ${order.status}`, 400);

    const hasDelivered = order.items.some((i) => i.deliveredQty > 0);
    if ((order.status === "shipped") && hasDelivered) {
      throw new SalesOrderError("Cannot cancel shipped order with delivered items", 400);
    }

    const releases = new Map<string, number>();

    if (order.status === "confirmed" || order.status === "processing") {
      for (const item of order.items) {
        releases.set(item.productId, (releases.get(item.productId) || 0) + item.orderedQty);
        const reservation = await tx.reservation.findFirst({
          where: { salesOrderItemId: item.id, status: "active" },
          orderBy: { createdAt: "asc" },
        });
        if (reservation) {
          await tx.reservation.update({ where: { id: reservation.id }, data: { status: "cancelled" } });
        }
      }
    }

    if (order.status === "partially_delivered") {
      for (const item of order.items) {
        const remaining = item.orderedQty - item.deliveredQty;
        if (remaining > 0) {
          releases.set(item.productId, (releases.get(item.productId) || 0) + remaining);
          const reservation = await tx.reservation.findFirst({
            where: { salesOrderItemId: item.id, status: "active" },
            orderBy: { createdAt: "asc" },
          });
          if (reservation) {
            await tx.reservation.update({ where: { id: reservation.id }, data: { status: "cancelled" } });
          }
        }
      }
    }

    const products = await tx.product.findMany({ where: { id: { in: Array.from(releases.keys()) } } });
    const productMap = new Map(products.map((p) => [p.id, p]));

    for (const [productId, qty] of releases) {
      await tx.product.update({ where: { id: productId }, data: { reservedStock: { decrement: qty } } });
      // Sync WarehouseStock
      await decrementReservedStock(tx, defaultWhId, productId, qty);
      const product = productMap.get(productId);
      await tx.inventoryLog.create({
        data: {
          type: "release",
          productId,
          oldStock: product?.stock ?? 0,
          newStock: product?.stock ?? 0,
          change: qty,
          clientName: order.client?.name || "",
          salesName: user.name || "",
          notes: `إلغاء حجز ${qty} وحدة من ${product?.name || productId} للطلب ${order.orderNumber}`,
          referenceType: "sales_order",
          referenceId: order.id,
          userId: user.userId,
          userName: user.name,
          userRole: user.role,
          entityType: "sales_order",
          entityId: order.id,
          beforeData: { reservedStock: product?.reservedStock ?? 0 },
          afterData: { reservedStock: Math.max((product?.reservedStock ?? 0) - qty, 0) },
        },
      });
    }

    await tx.salesOrder.update({
      where: { id },
      data: {
        status: "cancelled",
        version: { increment: 1 },
        statusHistory: {
          create: {
            fromStatus: order.status,
            toStatus: "cancelled",
            changedBy: user.userId,
            note: note || null,
            ip: meta.ip,
            userAgent: meta.userAgent,
            changedFields: ["status", "reservedStock", "version"],
            beforeState: JSON.parse(JSON.stringify({ status: order.status, version: order.version })),
            afterState: JSON.parse(JSON.stringify({ status: "cancelled", version: order.version + 1 })),
          },
        },
      },
    });

    const pendingApproval = await tx.salesOrderApproval.findFirst({
      where: { salesOrderId: id, status: "pending" },
    });
    if (pendingApproval) {
      await tx.salesOrderApproval.update({
        where: { id: pendingApproval.id },
        data: { status: "cancelled", rejectedBy: user.userId, rejectedAt: new Date(), reason: "Order cancelled" },
      });
    }

    return requireOrderFull(tx, id);
  });
}

// ─── Expiry (auto-cancel) ─────────────────────────────────────────────────────

export async function expireSalesOrders(client: PrismaClient): Promise<number> {
  let count = 0;
  const expired = await client.salesOrder.findMany({
    where: {
      status: { in: ["draft", "confirmed"] },
      expiresAt: { lte: new Date() },
    },
    include: { items: true, client: true },
  });

  for (const order of expired) {
    await runTx(client, async (tx) => {
      const defaultWhId = await getDefaultWarehouseId(tx);
      const releases = new Map<string, number>();
      if (order.status === "confirmed") {
        for (const item of order.items) {
          releases.set(item.productId, (releases.get(item.productId) || 0) + item.orderedQty);
          const reservation = await tx.reservation.findFirst({
            where: { salesOrderItemId: item.id, status: "active" },
            orderBy: { createdAt: "asc" },
          });
          if (reservation) {
            await tx.reservation.update({ where: { id: reservation.id }, data: { status: "cancelled" } });
          }
        }
      }

      for (const [productId, qty] of releases) {
        await tx.product.update({ where: { id: productId }, data: { reservedStock: { decrement: qty } } });
        // Sync WarehouseStock
        await decrementReservedStock(tx, defaultWhId, productId, qty);
        const product = await tx.product.findUnique({ where: { id: productId } });
        await tx.inventoryLog.create({
          data: {
            type: "release",
            productId,
            oldStock: product?.stock ?? 0,
            newStock: product?.stock ?? 0,
            change: qty,
            clientName: order.client?.name || "",
            notes: `إلغاء حجز ${qty} وحدة من ${product?.name || productId} للطلب ${order.orderNumber} لانتهاء الصلاحية`,
            referenceType: "sales_order",
            referenceId: order.id,
            userId: "system",
            userName: "system",
            userRole: "system",
            entityType: "sales_order",
            entityId: order.id,
            beforeData: { reservedStock: product?.reservedStock ?? 0 },
            afterData: { reservedStock: Math.max((product?.reservedStock ?? 0) - qty, 0) },
          },
        });
      }

      await tx.salesOrder.update({
        where: { id: order.id },
        data: {
          status: "cancelled",
          version: { increment: 1 },
          statusHistory: {
            create: {
              fromStatus: order.status,
              toStatus: "cancelled",
              changedBy: "system",
              note: "انتهاء صلاحية الطلب",
              changedFields: ["status", "reservedStock", "version"],
              beforeState: JSON.parse(JSON.stringify({ status: order.status, version: order.version })),
              afterState: JSON.parse(JSON.stringify({ status: "cancelled", version: order.version + 1 })),
            },
          },
        },
      });

      await createNotification(tx, {
        userId: order.createdBy || undefined,
        type: "order_expired",
        title: "انتهت صلاحية الطلب",
        message: `تم إلغاء الطلب ${order.orderNumber} لانتهاء صلاحيته`,
        entityType: "sales_order",
        entityId: order.id,
        referenceType: "sales_order",
        referenceId: order.id,
        priority: "low",
      });

      count++;
    });
  }

  return count;
}

// ─── Read endpoints ───────────────────────────────────────────────────────────

export async function listOrders(
  client: PrismaClient,
  filters: {
    status?: string;
    clientId?: string;
    search?: string;
    from?: string;
    to?: string;
    page?: number;
    limit?: number;
  }
) {
  const page = Number(filters.page) || 1;
  const limit = Number(filters.limit) || 20;
  const where: Prisma.SalesOrderWhereInput = { deletedAt: null };

  if (filters.status && filters.status !== "all") {
    const statuses = String(filters.status).split(",").map((s) => s.trim()).filter(Boolean);
    where.status = statuses.length === 1 ? statuses[0] : { in: statuses };
  }
  if (filters.clientId) where.clientId = filters.clientId;
  if (filters.search) {
    where.OR = [
      { orderNumber: { contains: filters.search, mode: "insensitive" } },
      { client: { name: { contains: filters.search, mode: "insensitive" } } },
      { reference: { contains: filters.search, mode: "insensitive" } },
    ];
  }
  if (filters.from || filters.to) {
    where.orderDate = {};
    if (filters.from) where.orderDate.gte = new Date(filters.from);
    if (filters.to) where.orderDate.lte = new Date(filters.to);
  }

  const [orders, total] = await Promise.all([
    client.salesOrder.findMany({
      where,
      include: {
        client: { select: { id: true, name: true } },
        items: { include: { product: { select: { id: true, name: true, sku: true, stock: true } } } },
        approvals: { select: { id: true, status: true, reason: true, createdAt: true }, orderBy: { createdAt: "desc" } },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    client.salesOrder.count({ where }),
  ]);

  // ربط المقاييس: returnedQty / netSoldQty (مرة واحدة لكل صفحة بدل N+1)
  if (orders.length > 0) {
    const orderIds = orders.map((o) => o.id);
    const returns = await client.returnOrder.findMany({
      where: {
        sourceType: "sales_order",
        sourceId: { in: orderIds },
        deletedAt: null,
        status: { in: ["received", "closed"] },
      },
      select: { sourceId: true, items: { select: { productId: true, receivedQty: true } } },
    });
    const perOrder = new Map<string, Map<string, number>>();
    for (const ret of returns) {
      if (!perOrder.has(ret.sourceId)) perOrder.set(ret.sourceId, new Map());
      const map = perOrder.get(ret.sourceId)!;
      for (const it of ret.items) {
        map.set(it.productId, (map.get(it.productId) || 0) + it.receivedQty);
      }
    }
    for (const order of orders) {
      const returned = perOrder.get(order.id) || new Map<string, number>();
      let returnedTotal = 0;
      let deliveredTotal = 0;
      for (const item of order.items as any[]) {
        const qty = Number(item.returnedQty ?? item.deliveredQty ?? item.orderedQty ?? 0);
        const ret = returned.get(item.productId) || 0;
        (item as any).returnedQty = ret;
        (item as any).netSoldQty = Math.max(qty - ret, 0);
        returnedTotal += ret;
        deliveredTotal += qty;
      }
      (order as any).returnedQty = returnedTotal;
      (order as any).netSoldQty = Math.max(deliveredTotal - returnedTotal, 0);
      decorateApproval(order as any);
    }
  }

  return {
    orders,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export async function getOrder(client: PrismaClient, id: string) {
  return runTx(client, async (tx) => {
    const order = await getOrderFull(tx, id);
    if (order && !order.deletedAt) {
      const returned = await getReturnedQtyBySource(client, "sales_order", id);
      let returnedTotal = 0;
      let deliveredTotal = 0;
      for (const item of order.items as any[]) {
        const qty = Number(item.returnedQty ?? item.deliveredQty ?? item.orderedQty ?? 0);
        const ret = returned.get(item.productId) || 0;
        (item as any).returnedQty = ret;
        (item as any).netSoldQty = Math.max(qty - ret, 0);
        returnedTotal += ret;
        deliveredTotal += qty;
      }
      (order as any).returnedQty = returnedTotal;
      (order as any).netSoldQty = Math.max(deliveredTotal - returnedTotal, 0);
      decorateApproval(order as any);
    }
    return order;
  });
}

export async function getOrderDeliveries(client: PrismaClient, id: string) {
  return client.salesDelivery.findMany({
    where: { salesOrderId: id },
    include: { items: { include: { product: { select: { id: true, name: true } } } } },
    orderBy: { deliveredAt: "desc" },
  });
}
