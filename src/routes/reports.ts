// ============================================================================
// src/routes/reports.ts  —  P2.13 (Inventory Value) + P2.11 (ABC Analysis)
// ============================================================================

import { Router } from 'express'
import { prisma } from '../config/database'
import { requireAuth, requirePermission } from '../middleware/auth'

const router = Router()

// ─────────────────────────────────────────────────────────────────────────
// GET /reports/value  — P2.13: التقرير المالي للمخزون
// ─────────────────────────────────────────────────────────────────────────
router.get('/reports/value', requireAuth, requirePermission('reports.view'), async (_req, res) => {
  try {
    const products = await prisma.product.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true, variant: true, stock: true, price: true, category: true },
    })

    let totalValue = 0
    let productsWithoutPrice = 0
    const categoryMap = new Map<string, { value: number; count: number; stock: number }>()

    for (const p of products) {
      const price = p.price ?? 0
      if (!p.price || p.price <= 0) productsWithoutPrice++
      const value = price * p.stock
      totalValue += value

      const catKey = p.category?.trim() || 'غير مصنّف'
      const cat = categoryMap.get(catKey) || { value: 0, count: 0, stock: 0 }
      cat.value += value
      cat.count += 1
      cat.stock += p.stock
      categoryMap.set(catKey, cat)
    }

    const byCategory = Array.from(categoryMap.entries())
      .map(([category, d]) => ({ category, ...d }))
      .sort((a, b) => b.value - a.value)

    const topProducts = products
      .map(p => ({ id: p.id, name: p.name, variant: p.variant, stock: p.stock, price: p.price ?? 0, value: (p.price ?? 0) * p.stock }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 10)

    res.json({
      totalValue,
      totalProducts: products.length,
      productsWithoutPrice,
      averageUnitPrice: products.length ? totalValue / Math.max(1, products.reduce((s, p) => s + p.stock, 0)) : 0,
      byCategory,
      topProducts,
    })
  } catch (err) {
    console.error('reports/value error', err)
    res.status(500).json({ error: 'فشل حساب التقرير المالي' })
  }
})

// ─────────────────────────────────────────────────────────────────────────
// GET /reports/abc  — P2.11: تحليل ABC حسب قيمة الصرف
// ─────────────────────────────────────────────────────────────────────────
router.get('/reports/abc', requireAuth, requirePermission('reports.view'), async (_req, res) => {
  try {
    const products = await prisma.product.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true, variant: true, price: true },
    })

    // مجموع الكميات المصروفة تاريخيًا لكل منتج (النوع 'withdraw' في السجل)
    const withdrawalLogs = await prisma.inventoryLog.groupBy({
      by: ['productId'],
      where: { type: 'withdraw' },
      _sum: { change: true },
    })
    const withdrawnQtyMap = new Map(withdrawalLogs.map(l => [l.productId, Math.abs(l._sum.change ?? 0)]))

    const ranked = products
      .map(p => {
        const withdrawnQty = withdrawnQtyMap.get(p.id) ?? 0
        const withdrawnValue = withdrawnQty * (p.price ?? 0)
        return { id: p.id, name: p.name, variant: p.variant, withdrawnQty, withdrawnValue }
      })
      .sort((a, b) => b.withdrawnValue - a.withdrawnValue)

    const totalValue = ranked.reduce((s, r) => s + r.withdrawnValue, 0)

    let cumulative = 0
    const classified = ranked.map(r => {
      cumulative += r.withdrawnValue
      const pct = totalValue > 0 ? cumulative / totalValue : 1
      const cls: 'A' | 'B' | 'C' = r.withdrawnValue === 0 ? 'C' : pct <= 0.8 ? 'A' : pct <= 0.95 ? 'B' : 'C'
      return { ...r, class: cls, cumulativePct: Math.round(pct * 1000) / 10 }
    })

    const summary = {
      A: classified.filter(c => c.class === 'A').length,
      B: classified.filter(c => c.class === 'B').length,
      C: classified.filter(c => c.class === 'C').length,
      totalValue,
      hasEnoughHistory: totalValue > 0 && withdrawalLogs.length >= 10,
    }

    res.json({ summary, products: classified })
  } catch (err) {
    console.error('reports/abc error', err)
    res.status(500).json({ error: 'فشل حساب تحليل ABC' })
  }
})

export default router
