/**
 * productIntelligence.ts — Product Intelligence + Reorder Engine
 *
 * Computes:
 * - Sales velocity (units/day, units/week)
 * - Days of stock remaining
 * - ABC classification (A=high value, B=medium, C=low)
 * - Trend analysis (increasing/decreasing/stable)
 * - Reorder suggestions (when stock <= reorderPoint)
 * - Auto-generate PO drafts for reorder
 */

import { PrismaClient } from "@prisma/client";

type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

export interface ProductIntelligence {
  productId: string;
  name: string;
  sku: string | null;
  currentStock: number;
  reorderPoint: number;
  maxStock: number;
  safetyStock: number;
  costPrice: number | null;
  price: number;
  // Velocity
  dailyVelocity: number;        // avg units sold per day (last 30 days)
  weeklyVelocity: number;       // avg units sold per week
  monthlyVelocity: number;      // avg units sold per month
  // Days of stock
  daysOfStock: number | null;   // null if no velocity
  // ABC
  abcClass: "A" | "B" | "C";
  revenueSharePercent: number;
  // Trend
  trend: "increasing" | "decreasing" | "stable" | "no_data";
  trendPercent: number;         // % change vs previous period
  // Reorder
  needsReorder: boolean;
  suggestedOrderQty: number;    // units to order to reach maxStock
  urgency: "critical" | "warning" | "normal";
  // Warehouse breakdown
  warehouseStock: Array<{ warehouseId: string; warehouseName: string; quantity: number }>;
}

export interface ReorderSuggestion {
  productId: string;
  productName: string;
  sku: string | null;
  currentStock: number;
  reorderPoint: number;
  maxStock: number;
  safetyStock: number;
  suggestedOrderQty: number;
  urgency: "critical" | "warning" | "normal";
  estimatedCost: number;
  dailyVelocity: number;
  daysUntilStockout: number | null;
  lastSupplierName: string | null;
  lastSupplierId: string | null;
}

// ─── Velocity Calculation ───────────────────────────────────────────────────

async function computeVelocities(
  tx: Tx,
  productId: string,
  dailyVelocityCache: Map<string, number>
): Promise<{ daily: number; weekly: number; monthly: number }> {
  if (dailyVelocityCache.has(productId)) {
    const d = dailyVelocityCache.get(productId)!;
    return { daily: d, weekly: d * 7, monthly: d * 30 };
  }

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const logs = await tx.inventoryLog.findMany({
    where: {
      productId,
      createdAt: { gte: thirtyDaysAgo },
      type: { in: ["sale", "withdraw"] },
    },
    select: { change: true, createdAt: true },
  });

  let totalSold = 0;
  for (const log of logs) {
    if (log.change < 0) totalSold += Math.abs(log.change);
  }

  const daily = totalSold / 30;
  dailyVelocityCache.set(productId, daily);

  return { daily, weekly: daily * 7, monthly: daily * 30 };
}

// ─── ABC Classification ────────────────────────────────────────────────────

function classifyAbc(
  products: Array<{ productId: string; revenue: number }>,
  totalRevenue: number
): Map<string, { class: "A" | "B" | "C"; share: number }> {
  const result = new Map<string, { class: "A" | "B" | "C"; share: number }>();

  // Sort by revenue descending
  const sorted = [...products].sort((a, b) => b.revenue - a.revenue);
  let cumulative = 0;

  for (const p of sorted) {
    cumulative += p.revenue;
    const share = totalRevenue > 0 ? (p.revenue / totalRevenue) * 100 : 0;
    const cumulativePercent = (cumulative / totalRevenue) * 100;

    let cls: "A" | "B" | "C";
    if (cumulativePercent <= 80) cls = "A";
    else if (cumulativePercent <= 95) cls = "B";
    else cls = "C";

    result.set(p.productId, { class: cls, share });
  }

  return result;
}

// ─── Trend Analysis ────────────────────────────────────────────────────────

async function computeTrend(
  tx: Tx,
  productId: string
): Promise<{ trend: "increasing" | "decreasing" | "stable" | "no_data"; percent: number }> {
  const now = new Date();
  const thirtyDaysAgo = new Date(now);
  thirtyDaysAgo.setDate(now.getDate() - 30);
  const sixtyDaysAgo = new Date(now);
  sixtyDaysAgo.setDate(now.getDate() - 60);

  const [recent, previous] = await Promise.all([
    tx.inventoryLog.findMany({
      where: {
        productId,
        createdAt: { gte: thirtyDaysAgo },
        type: { in: ["sale", "withdraw"] },
      },
      select: { change: true },
    }),
    tx.inventoryLog.findMany({
      where: {
        productId,
        createdAt: { gte: sixtyDaysAgo, lt: thirtyDaysAgo },
        type: { in: ["sale", "withdraw"] },
      },
      select: { change: true },
    }),
  ]);

  let recentSold = 0;
  for (const l of recent) if (l.change < 0) recentSold += Math.abs(l.change);
  let prevSold = 0;
  for (const l of previous) if (l.change < 0) prevSold += Math.abs(l.change);

  if (recentSold === 0 && prevSold === 0) return { trend: "no_data", percent: 0 };
  if (prevSold === 0) return { trend: "increasing", percent: recentSold > 0 ? 100 : 0 };

  const changePercent = ((recentSold - prevSold) / prevSold) * 100;

  if (changePercent > 20) return { trend: "increasing", percent: Math.round(changePercent) };
  if (changePercent < -20) return { trend: "decreasing", percent: Math.round(changePercent) };
  return { trend: "stable", percent: Math.round(changePercent) };
}

// ─── Main Intelligence Function ────────────────────────────────────────────

export async function getProductIntelligence(
  prisma: PrismaClient | Tx,
  filters?: { category?: string; abcClass?: string; needsReorder?: boolean; search?: string }
): Promise<ProductIntelligence[]> {
  const where: any = { deletedAt: null };
  if (filters?.category) where.category = filters.category;
  if (filters?.search) {
    where.OR = [
      { name: { contains: filters.search, mode: "insensitive" } },
      { sku: { contains: filters.search, mode: "insensitive" } },
    ];
  }

  const products = await prisma.product.findMany({ where, orderBy: { name: "asc" } });
  if (products.length === 0) return [];

  const productIds = products.map((p) => p.id);
  const dailyVelocityCache = new Map<string, number>();

  // Get all sales revenue per product for ABC
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const salesLogs = await prisma.inventoryLog.findMany({
    where: {
      productId: { in: productIds },
      createdAt: { gte: thirtyDaysAgo },
      type: { in: ["sale", "withdraw"] },
    },
    select: { productId: true, change: true },
  });

  const revenueByProduct = new Map<string, number>();
  for (const log of salesLogs) {
    if (log.change < 0) {
      const product = products.find((p) => p.id === log.productId);
      const unitPrice = product?.price || 0;
      revenueByProduct.set(
        log.productId,
        (revenueByProduct.get(log.productId) || 0) + Math.abs(log.change) * unitPrice
      );
    }
  }

  const totalRevenue = Array.from(revenueByProduct.values()).reduce((s, v) => s + v, 0);
  const abcMap = classifyAbc(
    Array.from(revenueByProduct.entries()).map(([productId, revenue]) => ({ productId, revenue })),
    totalRevenue
  );

  // Get warehouse stock
  const warehouseStocks = await prisma.warehouseStock.findMany({
    where: { productId: { in: productIds } },
    include: { warehouse: { select: { id: true, name: true } } },
  });
  const warehouseStockMap = new Map<string, Array<{ warehouseId: string; warehouseName: string; quantity: number }>>();
  for (const ws of warehouseStocks) {
    const arr = warehouseStockMap.get(ws.productId) || [];
    arr.push({ warehouseId: ws.warehouseId, warehouseName: ws.warehouse?.name || "Unknown", quantity: ws.quantity });
    warehouseStockMap.set(ws.productId, arr);
  }

  // Get last supplier for each product (from PO items)
  const lastPOItems = await prisma.$queryRaw`
    SELECT DISTINCT ON (poi."productId")
      poi."productId", po."supplierId", s."name" as "supplierName"
    FROM "PurchaseOrderItem" poi
    JOIN "PurchaseOrder" po ON po."id" = poi."orderId"
    LEFT JOIN "Supplier" s ON s."id" = po."supplierId"
    WHERE po."status" NOT IN ('cancelled')
    ORDER BY poi."productId", po."createdAt" DESC
  ` as any[];
  const lastSupplierMap = new Map<string, { id: string | null; name: string | null }>();
  for (const row of lastPOItems) {
    lastSupplierMap.set(row.productId, { id: row.supplierId, name: row.supplierName });
  }

  // Build intelligence for each product
  const results: ProductIntelligence[] = [];

  for (const product of products) {
    const { daily, weekly, monthly } = await computeVelocities(prisma as any, product.id, dailyVelocityCache);
    const daysOfStock = daily > 0 ? Math.round(product.stock / daily) : null;
    const abc = abcMap.get(product.id) || { class: "C" as const, share: 0 };
    const trend = await computeTrend(prisma as any, product.id);

    const reorderPoint = product.reorderPoint || 0;
    const maxStock = product.maxStock || 0;
    const safetyStock = product.safetyStock || 0;

    const needsReorder = product.stock <= reorderPoint && reorderPoint > 0;
    const suggestedOrderQty = needsReorder ? Math.max(0, maxStock - product.stock) : 0;

    let urgency: "critical" | "warning" | "normal" = "normal";
    if (product.stock <= safetyStock && safetyStock > 0) urgency = "critical";
    else if (needsReorder) urgency = "warning";

    // Apply filters
    if (filters?.abcClass && abc.class !== filters.abcClass) continue;
    if (filters?.needsReorder && !needsReorder) continue;

    results.push({
      productId: product.id,
      name: product.name,
      sku: product.sku,
      currentStock: product.stock,
      reorderPoint,
      maxStock,
      safetyStock,
      costPrice: product.costPrice ? Number(product.costPrice) : null,
      price: Number(product.price),
      dailyVelocity: Math.round(daily * 100) / 100,
      weeklyVelocity: Math.round(weekly * 100) / 100,
      monthlyVelocity: Math.round(monthly * 100) / 100,
      daysOfStock,
      abcClass: abc.class,
      revenueSharePercent: Math.round(abc.share * 100) / 100,
      trend: trend.trend,
      trendPercent: trend.percent,
      needsReorder,
      suggestedOrderQty,
      urgency,
      warehouseStock: warehouseStockMap.get(product.id) || [],
    });
  }

  return results;
}

// ─── Reorder Suggestions ───────────────────────────────────────────────────

export async function getReorderSuggestions(
  prisma: PrismaClient | Tx,
  options?: { includeNonCritical?: boolean }
): Promise<ReorderSuggestion[]> {
  const products = await prisma.product.findMany({
    where: {
      deletedAt: null,
      reorderPoint: { gt: 0 },
    },
  });

  const suggestions: ReorderSuggestion[] = [];
  const dailyVelocityCache = new Map<string, number>();

  for (const product of products) {
    const { daily } = await computeVelocities(prisma as any, product.id, dailyVelocityCache);
    const needsReorder = product.stock <= product.reorderPoint;
    if (!needsReorder) continue;

    const daysUntilStockout = daily > 0 ? Math.round(product.stock / daily) : null;
    const suggestedOrderQty = Math.max(0, product.maxStock - product.stock);

    let urgency: "critical" | "warning" | "normal" = "warning";
    if (product.stock <= product.safetyStock) urgency = "critical";

    const estimatedCost = suggestedOrderQty * (Number(product.costPrice) || 0);

    // Get last supplier
    const lastPOItem = await prisma.$queryRaw`
      SELECT po."supplierId", s."name" as "supplierName"
      FROM "PurchaseOrderItem" poi
      JOIN "PurchaseOrder" po ON po."id" = poi."orderId"
      LEFT JOIN "Supplier" s ON s."id" = po."supplierId"
      WHERE poi."productId" = ${product.id} AND po."status" NOT IN ('cancelled')
      ORDER BY po."createdAt" DESC LIMIT 1
    ` as any[];

    suggestions.push({
      productId: product.id,
      productName: product.name,
      sku: product.sku,
      currentStock: product.stock,
      reorderPoint: product.reorderPoint,
      maxStock: product.maxStock,
      safetyStock: product.safetyStock,
      suggestedOrderQty,
      urgency,
      estimatedCost: Math.round(estimatedCost * 100) / 100,
      dailyVelocity: Math.round(daily * 100) / 100,
      daysUntilStockout,
      lastSupplierName: lastPOItem[0]?.supplierName || null,
      lastSupplierId: lastPOItem[0]?.supplierId || null,
    });
  }

  // Sort by urgency: critical first
  suggestions.sort((a, b) => {
    const urgencyOrder = { critical: 0, warning: 1, normal: 2 };
    return (urgencyOrder[a.urgency] ?? 3) - (urgencyOrder[b.urgency] ?? 3);
  });

  return suggestions;
}

// ─── Auto-Generate PO Draft from Reorder Suggestions ───────────────────────

export async function generateReorderPODraft(
  tx: Tx,
  suggestions: ReorderSuggestion[],
  userId: string,
  userName: string
): Promise<string | null> {
  if (suggestions.length === 0) return null;

  // Group by lastSupplierId
  const bySupplier = new Map<string, ReorderSuggestion[]>();
  for (const s of suggestions) {
    const key = s.lastSupplierId ?? "unassigned";
    const arr = bySupplier.get(key) || [];
    arr.push(s);
    bySupplier.set(key, arr);
  }

  let poId: string | null = null;

  for (const [supplierId, items] of bySupplier) {
    if (supplierId === "unassigned") continue; // Skip items without supplier

    const po = await tx.purchaseOrder.create({
      data: {
        orderNumber: `AUTO-PO-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
        supplierId,
        status: "draft",
        notes: `Auto-generated reorder from Product Intelligence engine — ${new Date().toLocaleDateString("ar-EG")}`,
        createdBy: userId,
        items: {
          create: items.map((item) => ({
            productId: item.productId,
            quantity: item.suggestedOrderQty,
            unitPrice: 0, // To be filled by manager
          })),
        },
      },
      include: { items: true },
    });

    if (!poId) poId = po.id;
  }

  return poId;
}
