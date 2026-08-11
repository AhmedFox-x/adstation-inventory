// ============================================================================
// src/routes/dashboard.ts  —  P6 (Point 6): Executive Dashboard + KPIs
// Aggregates all dashboard data in a single read-only call (reports.view).
// Archived products (deletedAt) are excluded from every operational KPI.
// ============================================================================

import { Router } from "express";
import { prisma } from "../config/database";
import { requireAuth, requirePermission } from "../middleware/auth";

const router = Router();

const DAY_MS = 24 * 60 * 60 * 1000;

// ── GET /dashboard ────────────────────────────────────────────────────────────
router.get("/dashboard", requireAuth, requirePermission("reports.view"), async (_req, res, next) => {
  try {
    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);

    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setHours(0, 0, 0, 0);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 29);

    const [products, recentLogs, seriesLogs, withdrawalGroups] = await Promise.all([
      prisma.product.findMany({
        where: { deletedAt: null },
        select: {
          id: true, name: true, variant: true, stock: true,
          minStock: true, price: true, category: true,
        },
      }),
      prisma.inventoryLog.findMany({
        take: 10,
        orderBy: { createdAt: "desc" },
        include: { product: { select: { name: true } } },
      }),
      prisma.inventoryLog.findMany({
        where: { createdAt: { gte: thirtyDaysAgo } },
        select: { id: true, type: true, change: true, productId: true, createdAt: true },
      }),
      prisma.inventoryLog.groupBy({
        by: ["productId"],
        where: { type: "withdraw" },
        _sum: { change: true },
      }),
    ]);

    // ── KPIs ────────────────────────────────────────────────────────────────
    const priceMap = new Map(products.map((p) => [p.id, p.price ?? 0]));
    const activeIds = new Set(products.map((p) => p.id));
    const totalValue = products.reduce((s, p) => s + (p.price ?? 0) * p.stock, 0);
    const totalItems = products.reduce((s, p) => s + p.stock, 0);
    const totalProducts = products.length;
    const lowStockCount = products.filter((p) => p.stock > 0 && p.stock < p.minStock).length;
    const outOfStockCount = products.filter((p) => p.stock === 0).length;
    const productsWithoutPrice = products.filter((p) => !p.price || p.price <= 0).length;

    // Operational movement: only movements on currently active products.
    const activeLogs = seriesLogs.filter((l) => activeIds.has(l.productId));
    const todayLogs = activeLogs.filter((l) => l.createdAt >= todayStart);
    const todayUpQty = todayLogs.filter((l) => l.change > 0).reduce((s, l) => s + l.change, 0);
    const todayDownQty = todayLogs.filter((l) => l.change < 0).reduce((s, l) => s + Math.abs(l.change), 0);
    const todayUpValue = todayLogs
      .filter((l) => l.change > 0)
      .reduce((s, l) => s + l.change * (priceMap.get(l.productId) ?? 0), 0);
    const todayDownValue = todayLogs
      .filter((l) => l.change < 0)
      .reduce((s, l) => s + Math.abs(l.change) * (priceMap.get(l.productId) ?? 0), 0);

    // ── 30-day series (zero-filled) ─────────────────────────────────────────
    const dayBuckets = new Map<string, { up: number; down: number; moves: number }>();
    for (let i = 0; i < 30; i++) {
      const d = new Date(thirtyDaysAgo.getTime() + i * DAY_MS);
      dayBuckets.set(d.toISOString().slice(0, 10), { up: 0, down: 0, moves: 0 });
    }
    for (const l of activeLogs) {
      const key = l.createdAt.toISOString().slice(0, 10);
      const b = dayBuckets.get(key);
      if (!b) continue;
      b.moves++;
      if (l.change > 0) b.up += l.change;
      else if (l.change < 0) b.down += Math.abs(l.change);
    }
    const series = Array.from(dayBuckets.entries()).map(([date, v]) => ({ date, ...v }));

    // ── byCategory (value) ──────────────────────────────────────────────────
    const catMap = new Map<string, { value: number; count: number; stock: number }>();
    for (const p of products) {
      const key = p.category?.trim() || "غير مصنّف";
      const c = catMap.get(key) || { value: 0, count: 0, stock: 0 };
      c.value += (p.price ?? 0) * p.stock;
      c.count++;
      c.stock += p.stock;
      catMap.set(key, c);
    }
    const byCategory = Array.from(catMap.entries())
      .map(([category, d]) => ({ category, ...d }))
      .sort((a, b) => b.value - a.value);

    // ── topMovers (last 30d by |change|, active products only) ──────────────
    const productInfo = new Map(products.map((p) => [p.id, p]));
    const moverMap = new Map<string, number>();
    for (const l of activeLogs) {
      moverMap.set(l.productId, (moverMap.get(l.productId) ?? 0) + Math.abs(l.change));
    }
    const topMovers = Array.from(moverMap.entries())
      .map(([productId, moved]) => {
        const p = productInfo.get(productId);
        return {
          productId,
          name: p?.name ?? null,
          variant: p?.variant ?? null,
          moved,
          value: moved * (p ? p.price ?? 0 : 0),
        };
      })
      .filter((m) => m.name !== null)
      .sort((a, b) => b.moved - a.moved)
      .slice(0, 10);

    // ── topValue (stock value) ──────────────────────────────────────────────
    const topValue = products
      .map((p) => ({
        id: p.id, name: p.name, variant: p.variant,
        stock: p.stock, price: p.price ?? 0, value: (p.price ?? 0) * p.stock,
      }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 10);

    // ── lowStock alerts (top 8 by value at risk) ────────────────────────────
    const lowStockAlerts = products
      .filter((p) => p.stock > 0 && p.stock < p.minStock)
      .map((p) => ({
        id: p.id, name: p.name, variant: p.variant,
        stock: p.stock, minStock: p.minStock, value: (p.price ?? 0) * p.stock,
      }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 8);

    // ── ABC summary (all-time withdrawals, same logic as /reports/abc) ──────
    const withdrawnQtyMap = new Map(withdrawalGroups.map((l) => [l.productId, Math.abs(l._sum.change ?? 0)]));
    const ranked = products
      .map((p) => {
        const withdrawnQty = withdrawnQtyMap.get(p.id) ?? 0;
        return { withdrawnValue: withdrawnQty * (p.price ?? 0) };
      })
      .sort((a, b) => b.withdrawnValue - a.withdrawnValue);
    const abcTotal = ranked.reduce((s, r) => s + r.withdrawnValue, 0);
    let abcCum = 0;
    const abc = { A: 0, B: 0, C: 0, totalValue: abcTotal, hasEnoughHistory: abcTotal > 0 && withdrawalGroups.length >= 10 };
    for (const r of ranked) {
      abcCum += r.withdrawnValue;
      const pct = abcTotal > 0 ? abcCum / abcTotal : 1;
      const cls = r.withdrawnValue === 0 ? "C" : pct <= 0.8 ? "A" : pct <= 0.95 ? "B" : "C";
      abc[cls]++;
    }

    // ── recentLogs (last 10 with permit number) ─────────────────────────────
    const recentLogsWithPermit = await Promise.all(
      recentLogs.map(async (l) => {
        let permitNumber: string | null = null;
        if (l.referenceType === "withdrawal" && l.referenceId) {
          const w = await prisma.withdrawalPermit.findUnique({
            where: { id: l.referenceId },
            select: { permitNumber: true, permitNumberOrig: true },
          });
          permitNumber = w?.permitNumberOrig || w?.permitNumber || null;
        } else if (l.referenceType === "supply" && l.referenceId) {
          const s = await prisma.supplyPermit.findUnique({
            where: { id: l.referenceId },
            select: { permitNumber: true, permitNumberOrig: true },
          });
          permitNumber = s?.permitNumberOrig || s?.permitNumber || null;
        }
        return {
          id: l.id, type: l.type, permitNumber, productId: l.productId,
          productName: l.product.name, oldStock: l.oldStock, newStock: l.newStock,
          change: l.change, clientName: l.clientName, salesName: l.salesName,
          userId: l.userId, userName: l.userName, userRole: l.userRole,
          notes: l.notes === "via scan" ? null : l.notes, createdAt: l.createdAt,
        };
      })
    );

    res.json({
      kpis: {
        totalValue,
        totalItems,
        totalProducts,
        lowStock: lowStockCount,
        outOfStock: outOfStockCount,
        productsWithoutPrice,
        todayMoves: todayLogs.length,
        todayUpQty,
        todayDownQty,
        todayUpValue,
        todayDownValue,
      },
      series,
      byCategory,
      topMovers,
      topValue,
      lowStock: lowStockAlerts,
      abc,
      recentLogs: recentLogsWithPermit,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
