/**
 * stockHistory.ts — Historical Stock + Incoming/Outgoing + Quarantine Release
 *
 * 1. Historical Stock: reconstruct stock at any point in time from inventory logs
 * 2. Incoming: what's on order (pending/approved POs)
 * 3. Outgoing: what's committed (confirmed/shipped SOs)
 * 4. Quarantine Release: move quarantined stock back to available
 */

import { PrismaClient } from "@prisma/client";
import { getCostAtDate } from "./costService";

type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

// ─── Historical Stock ──────────────────────────────────────────────────────

export interface HistoricalStockPoint {
  date: string;
  stock: number;
  incoming: number;
  outgoing: number;
  netChange: number;
}

export async function getHistoricalStock(
  prisma: PrismaClient | Tx,
  productId: string,
  days: number = 30
): Promise<HistoricalStockPoint[]> {
  const since = new Date();
  since.setDate(since.getDate() - days);

  // Get current product stock
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { stock: true },
  });
  if (!product) return [];

  // Get all inventory logs for this product since the date
  const logs = await prisma.inventoryLog.findMany({
    where: {
      productId,
      createdAt: { gte: since },
    },
    orderBy: { createdAt: "asc" },
    select: {
      createdAt: true,
      change: true,
      type: true,
    },
  });

  // Build daily history by going backwards from current stock
  // First, compute the net change from logs
  let totalLogChange = 0;
  for (const log of logs) {
    totalLogChange += log.change;
  }

  // Stock at `since` = current stock - total changes since then
  const startingStock = product.stock - totalLogChange;

  // Build daily buckets
  const dailyData = new Map<string, { incoming: number; outgoing: number; netChange: number }>();
  for (const log of logs) {
    const day = log.createdAt.toISOString().slice(0, 10);
    const entry = dailyData.get(day) || { incoming: 0, outgoing: 0, netChange: 0 };
    entry.netChange += log.change;
    if (log.change > 0) entry.incoming += log.change;
    if (log.change < 0) entry.outgoing += Math.abs(log.change);
    dailyData.set(day, entry);
  }

  // Build the result array
  const result: HistoricalStockPoint[] = [];
  let runningStock = startingStock;

  const today = new Date();
  for (let i = days; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dayStr = d.toISOString().slice(0, 10);

    const dayData = dailyData.get(dayStr);
    const incoming = dayData?.incoming || 0;
    const outgoing = dayData?.outgoing || 0;
    const netChange = dayData?.netChange || 0;

    if (dayData) {
      runningStock += netChange;
    }

    result.push({
      date: dayStr,
      stock: Math.max(0, runningStock),
      incoming,
      outgoing,
      netChange,
    });
  }

  return result;
}

// ─── Historical Inventory Valuation ──────────────────────────────────────────
// Reconstructs the stock quantity and average cost for each product on a given
// date, using inventory logs (for quantity) and CostHistory (for cost).
//
// CRITICAL RULE: If a product has NO CostHistory entry covering the requested
// date, its cost is treated as "no historical cost data" (null) — we NEVER
// fall back to the current costPrice, because that would produce misleading
// historical valuations.

export interface HistoricalValuationItem {
  productId: string;
  productName: string;
  category: string | null;
  quantityAtDate: number;
  costAtDate: number | null;
  valueAtDate: number | null; // null when cost is unavailable
  hasHistoricalCost: boolean;
}

export async function getValuationAtDate(
  prisma: PrismaClient | Tx,
  date: Date
): Promise<{ items: HistoricalValuationItem[]; unavailableCostCount: number }> {
  // All active products
  const products = await prisma.product.findMany({
    where: { deletedAt: null },
    select: { id: true, name: true, category: true, stock: true },
  });

  const items: HistoricalValuationItem[] = [];
  let unavailableCostCount = 0;

  for (const product of products) {
    // 1. Reconstruct quantity at date from inventory logs
    //    stockAtDate = currentStock - sum(change of logs AFTER date)
    const logsAfter = await prisma.inventoryLog.aggregate({
      where: { productId: product.id, createdAt: { gt: date } },
      _sum: { change: true },
    });
    const deltaAfter = logsAfter._sum.change ?? 0;
    const quantityAtDate = product.stock - deltaAfter;

    // Skip products that had zero qty before the date (or never existed)
    // Note: a product created after `date` won't have logs before; its
    // quantityAtDate would be negative — clamp handling below.

    // 2. Resolve cost at date from cost history (NO fallback to current)
    const costAtDate = await getCostAtDate(prisma, product.id, date);

    const hasHistoricalCost = costAtDate !== null;
    if (!hasHistoricalCost) unavailableCostCount++;

    items.push({
      productId: product.id,
      productName: product.name,
      category: product.category,
      quantityAtDate: Math.max(0, quantityAtDate),
      costAtDate,
      valueAtDate: costAtDate !== null ? Math.round(costAtDate * Math.max(0, quantityAtDate) * 100) / 100 : null,
      hasHistoricalCost,
    });
  }

  return { items, unavailableCostCount };
}

// ─── Incoming Stock (Pending POs) ──────────────────────────────────────────

export interface IncomingItem {
  productId: string;
  productName: string;
  sku: string | null;
  totalOrdered: number;
  totalReceived: number;
  totalPending: number;
  purchaseOrders: Array<{
    poId: string;
    poNumber: string;
    supplierName: string | null;
    orderedQty: number;
    receivedQty: number;
    pendingQty: number;
    expectedDelivery: Date | null;
    status: string;
  }>;
}

export async function getIncomingStock(
  prisma: PrismaClient | Tx,
  options?: { warehouseId?: string }
): Promise<IncomingItem[]> {
  // Find all PO items that are not fully received
  const poItems = await prisma.purchaseOrderItem.findMany({
    where: {
      order: {
        status: { in: ["approved", "sent", "partially_received"] },
        deletedAt: null,
      },
    },
    include: {
      order: {
        include: {
          supplier: { select: { name: true } },
        },
      },
      product: { select: { id: true, name: true, sku: true } },
    },
  });

  // Group by product
  const byProduct = new Map<string, IncomingItem>();
  for (const item of poItems) {
    const pendingQty = item.quantity - item.receivedQuantity;
    if (pendingQty <= 0) continue;

    const pid = item.productId;
    if (!byProduct.has(pid)) {
      byProduct.set(pid, {
        productId: pid,
        productName: item.product.name,
        sku: item.product.sku,
        totalOrdered: 0,
        totalReceived: 0,
        totalPending: 0,
        purchaseOrders: [],
      });
    }

    const entry = byProduct.get(pid)!;
    entry.totalOrdered += item.quantity;
    entry.totalReceived += item.receivedQuantity;
    entry.totalPending += pendingQty;
    entry.purchaseOrders.push({
      poId: item.orderId,
      poNumber: item.order.orderNumber,
      supplierName: item.order.supplier?.name || null,
      orderedQty: item.quantity,
      receivedQty: item.receivedQuantity,
      pendingQty,
      expectedDelivery: item.order.expectedDeliveryDate,
      status: item.order.status,
    });
  }

  return Array.from(byProduct.values()).sort((a, b) => b.totalPending - a.totalPending);
}

// ─── Outgoing Stock (Confirmed/Shipped SOs) ────────────────────────────────

export interface OutgoingItem {
  productId: string;
  productName: string;
  sku: string | null;
  totalOrdered: number;
  totalDelivered: number;
  totalPending: number;
  salesOrders: Array<{
    soId: string;
    soNumber: string;
    clientName: string | null;
    orderedQty: number;
    deliveredQty: number;
    pendingQty: number;
    status: string;
  }>;
}

export async function getOutgoingStock(
  prisma: PrismaClient | Tx
): Promise<OutgoingItem[]> {
  // Find all SO items that are not fully delivered
  const soItems = await prisma.salesOrderItem.findMany({
    where: {
      order: {
        status: { in: ["confirmed", "processing", "shipped", "partially_delivered"] },
        deletedAt: null,
      },
    },
    include: {
      order: {
        include: {
          client: { select: { name: true } },
        },
      },
      product: { select: { id: true, name: true, sku: true } },
    },
  });

  // Group by product
  const byProduct = new Map<string, OutgoingItem>();
  for (const item of soItems) {
    const pendingQty = item.orderedQty - item.deliveredQty;
    if (pendingQty <= 0) continue;

    const pid = item.productId;
    if (!byProduct.has(pid)) {
      byProduct.set(pid, {
        productId: pid,
        productName: item.product.name,
        sku: item.product.sku,
        totalOrdered: 0,
        totalDelivered: 0,
        totalPending: 0,
        salesOrders: [],
      });
    }

    const entry = byProduct.get(pid)!;
    entry.totalOrdered += item.orderedQty;
    entry.totalDelivered += item.deliveredQty;
    entry.totalPending += pendingQty;
    entry.salesOrders.push({
      soId: item.orderId,
      soNumber: item.order.orderNumber,
      clientName: item.order.client?.name || null,
      orderedQty: item.orderedQty,
      deliveredQty: item.deliveredQty,
      pendingQty,
      status: item.order.status,
    });
  }

  return Array.from(byProduct.values()).sort((a, b) => b.totalPending - a.totalPending);
}

// ─── Quarantine Release ────────────────────────────────────────────────────

export interface QuarantineReleaseResult {
  productId: string;
  productName: string;
  releasedQty: number;
  previousQuarantineStock: number;
  previousStock: number;
  newStock: number;
  newQuarantineStock: number;
}

export async function releaseQuarantine(
  tx: Tx,
  productId: string,
  quantity: number,
  userId: string,
  userName: string,
  reason: string
): Promise<QuarantineReleaseResult> {
  const product = await tx.product.findUnique({ where: { id: productId } });
  if (!product) throw new Error("Product not found");
  if (product.deletedAt) throw new Error("Product is archived");

  if (quantity <= 0 || quantity > product.quarantineStock) {
    throw new Error(`Invalid quantity: ${quantity}. Available quarantine: ${product.quarantineStock}`);
  }

  // Atomic updates
  await tx.product.update({
    where: { id: productId },
    data: {
      quarantineStock: { decrement: quantity },
      stock: { increment: quantity },
    },
  });

  // Inventory log
  const oldStock = product.stock;
  const oldQuarantine = product.quarantineStock;
  await tx.inventoryLog.create({
    data: {
      type: "quarantine_release",
      productId,
      oldStock,
      newStock: oldStock + quantity,
      change: quantity,
      notes: `إطلاق ${quantity} وحدة من الحجر — ${reason}`,
      userId,
      userName,
      userRole: "",
      entityType: "product",
      entityId: productId,
      beforeData: { stock: oldStock, quarantineStock: oldQuarantine },
      afterData: { stock: oldStock + quantity, quarantineStock: oldQuarantine - quantity },
    },
  });

  return {
    productId,
    productName: product.name,
    releasedQty: quantity,
    previousQuarantineStock: oldQuarantine,
    previousStock: oldStock,
    newStock: oldStock + quantity,
    newQuarantineStock: oldQuarantine - quantity,
  };
}

// ─── Quarantine List ───────────────────────────────────────────────────────

export interface QuarantineItem {
  productId: string;
  productName: string;
  sku: string | null;
  quarantineStock: number;
  costPrice: number | null;
  totalValue: number;
  lastQuarantineLog: {
    date: Date;
    notes: string | null;
  } | null;
}

export async function getQuarantineList(
  prisma: PrismaClient | Tx
): Promise<QuarantineItem[]> {
  const products = await prisma.product.findMany({
    where: {
      deletedAt: null,
      quarantineStock: { gt: 0 },
    },
    orderBy: { quarantineStock: "desc" },
  });

  const results: QuarantineItem[] = [];

  for (const product of products) {
    // Find the most recent quarantine-related inventory log
    const lastLog = await prisma.inventoryLog.findFirst({
      where: {
        productId: product.id,
        type: { in: ["CUSTOMER_RETURN", "quarantine_release"] },
      },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true, notes: true },
    });

    results.push({
      productId: product.id,
      productName: product.name,
      sku: product.sku,
      quarantineStock: product.quarantineStock,
      costPrice: product.costPrice ? Number(product.costPrice) : null,
      totalValue: product.quarantineStock * (Number(product.costPrice) || 0),
      lastQuarantineLog: lastLog
        ? { date: lastLog.createdAt, notes: lastLog.notes }
        : null,
    });
  }

  return results;
}
