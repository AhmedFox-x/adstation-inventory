// ============================================================================
// src/routes/reports.ts  —  P2.13 (Inventory Value) + P2.11 (ABC Analysis)
// ============================================================================

import { Router } from 'express'
import { prisma } from '../config/database'
import { requireAuth, requirePermission } from '../middleware/auth'
import { getValuationAtDate } from '../services/stockHistory'

const router = Router()

// ─────────────────────────────────────────────────────────────────────────
// GET /reports/value  — P2.13: التقرير المالي للمخزون
// ─────────────────────────────────────────────────────────────────────────
router.get('/reports/value', requireAuth, requirePermission('reports.view'), async (_req, res) => {
  try {
    const products = await prisma.product.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true, variant: true, stock: true, price: true, category: true, costPrice: true },
      take: 10000,
    })

    let totalValue = 0
    let productsWithoutCost = 0
    let productsWithCost = 0
    const categoryMap = new Map<string, { value: number; count: number; stock: number }>()

    for (const p of products) {
      // Prefer costPrice (actual purchase cost), fallback to price (selling)
      const valuation = p.costPrice && p.costPrice > 0 ? p.costPrice : (p.price ?? 0)
      if (!p.costPrice || p.costPrice <= 0) productsWithoutCost++
      else productsWithCost++
      const value = valuation * p.stock
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
      .map(p => {
        const valuation = p.costPrice && p.costPrice > 0 ? p.costPrice : (p.price ?? 0)
        return {
          id: p.id, name: p.name, variant: p.variant, stock: p.stock,
          price: p.price ?? 0, costPrice: p.costPrice ?? null,
          value: valuation * p.stock,
          valueSource: p.costPrice && p.costPrice > 0 ? 'cost' : 'selling_price',
        }
      })
      .sort((a, b) => b.value - a.value)
      .slice(0, 10)

    res.json({
      totalValue,
      totalProducts: products.length,
      productsWithCost,
      productsWithoutCost,
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
      select: { id: true, name: true, variant: true, price: true, costPrice: true },
      take: 10000,
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
        const valuation = p.costPrice && p.costPrice > 0 ? p.costPrice : (p.price ?? 0)
        const withdrawnValue = withdrawnQty * valuation
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

// ─────────────────────────────────────────────────────────────────────────
// GET /reports/valuation  — Historical Inventory Valuation (point-in-time)
// ?date=YYYY-MM-DD  (optional; if omitted returns current snapshot summary)
// ─────────────────────────────────────────────────────────────────────────
router.get('/reports/valuation', requireAuth, requirePermission('reports.view'), async (req, res) => {
  try {
    const dateParam = req.query.date as string | undefined
    if (!dateParam) {
      // Current snapshot (same logic as /reports/value but with reserves + byWarehouse)
      const products = await prisma.product.findMany({
        where: { deletedAt: null },
        select: { id: true, name: true, stock: true, reservedStock: true, category: true, costPrice: true },
        take: 10000,
      })

      let totalValue = 0
      let availableValue = 0
      let reservedValue = 0
      let costedCount = 0
      const catMap = new Map<string, { value: number; count: number; stock: number }>()

      for (const p of products) {
        const unitCost = p.costPrice && p.costPrice > 0 ? p.costPrice : null
        const value = unitCost !== null ? unitCost * p.stock : 0
        totalValue += value
        availableValue += unitCost !== null ? unitCost * (p.stock - p.reservedStock) : 0
        reservedValue += unitCost !== null ? unitCost * p.reservedStock : 0
        if (unitCost !== null) costedCount++
        const catKey = p.category?.trim() || 'غير مصنّف'
        const c = catMap.get(catKey) || { value: 0, count: 0, stock: 0 }
        c.value += value
        c.count += 1
        c.stock += p.stock
        catMap.set(catKey, c)
      }

      // byWarehouse using product cost (approximate): cost per unit same everywhere
      const allStocks = await prisma.warehouseStock.findMany({
        where: { quantity: { gt: 0 } },
        select: { warehouseId: true, productId: true, quantity: true },
      })
      const productCost = new Map(products.map(p => [p.id, (p.costPrice && p.costPrice > 0 ? p.costPrice : 0)]))
      const whMap = new Map<string, { value: number; qty: number }>()
      for (const s of allStocks) {
        const cost = productCost.get(s.productId) || 0
        const e = whMap.get(s.warehouseId) || { value: 0, qty: 0 }
        e.value += cost * s.quantity
        e.qty += s.quantity
        whMap.set(s.warehouseId, e)
      }
      const warehouseNames = await prisma.warehouse.findMany({ select: { id: true, name: true } })
      const byWarehouse = Array.from(whMap.entries()).map(([wid, d]) => ({
        warehouseId: wid,
        warehouseName: warehouseNames.find(w => w.id === wid)?.name || wid,
        value: Math.round(d.value * 100) / 100,
        qty: d.qty,
      })).sort((a, b) => b.value - a.value)

      res.json({
        mode: 'current',
        date: new Date().toISOString().slice(0, 10),
        totalValue: Math.round(totalValue * 100) / 100,
        availableValue: Math.round(availableValue * 100) / 100,
        reservedValue: Math.round(reservedValue * 100) / 100,
        totalQuantity: products.reduce((s, p) => s + p.stock, 0),
        costedCount,
        productsWithoutCost: products.length - costedCount,
        byCategory: Array.from(catMap.entries()).map(([category, d]) => ({ category, ...d })).sort((a, b) => b.value - a.value),
        byWarehouse,
      })
      return
    }

    // Historical mode
    const date = new Date(dateParam)
    if (isNaN(date.getTime())) {
      res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' })
      return
    }

    const result = await getValuationAtDate(prisma, date)

    let totalValue = 0
    let unavailableValue = 0
    const catMap = new Map<string, { value: number; count: number; qty: number }>()

    for (const item of result.items) {
      if (item.valueAtDate !== null) {
        totalValue += item.valueAtDate
      } else {
        unavailableValue += (item.quantityAtDate > 0 ? 1 : 0)
      }
      const catKey = item.category?.trim() || 'غير مصنّف'
      const c = catMap.get(catKey) || { value: 0, count: 0, qty: 0 }
      c.count += 1
      c.qty += item.quantityAtDate
      c.value += item.valueAtDate ?? 0
      catMap.set(catKey, c)
    }

    res.json({
      mode: 'historical',
      date: dateParam,
      totalValue: Math.round(totalValue * 100) / 100,
      unavailableHistoricalValue: result.unavailableCostCount,
      totalProducts: result.items.length,
      byCategory: Array.from(catMap.entries()).map(([category, d]) => ({ category, ...d })).sort((a, b) => b.value - a.value),
      topProducts: result.items
        .filter(i => i.valueAtDate !== null)
        .sort((a, b) => (b.valueAtDate ?? 0) - (a.valueAtDate ?? 0))
        .slice(0, 10)
        .map(i => ({ id: i.productId, name: i.productName, quantity: i.quantityAtDate, cost: i.costAtDate, value: i.valueAtDate })),
    })
  } catch (err) {
    console.error('reports/valuation error', err)
    res.status(500).json({ error: 'فشل حساب تقييم المخزون' })
  }
})

// ─────────────────────────────────────────────────────────────────────────
// GET /reports/profitability  — Sales profitability (revenue/COGS/margin)
// ?from=&to=&productId=&category=
// ─────────────────────────────────────────────────────────────────────────
router.get('/reports/profitability', requireAuth, requirePermission('reports.view'), async (req, res) => {
  try {
    const { from, to, productId, category } = req.query as Record<string, string>
    const itemWhere: any = {}
    if (productId) itemWhere.productId = productId
    if (category) itemWhere.category = category

    const items = await prisma.salesOrderItem.findMany({
      where: itemWhere,
      include: {
        product: { select: { id: true, name: true, category: true } },
      },
    })

    const orderIds = Array.from(new Set(items.map(i => i.orderId)))
    if (orderIds.length === 0) {
      res.json({ summary: { revenue: 0, quantity: 0, cogs: 0, grossProfit: 0, marginPct: null, incompleteItems: 0, profitabilityComplete: true }, byProduct: [] })
      return
    }

    const orders = await prisma.salesOrder.findMany({
      where: { id: { in: orderIds }, deletedAt: null },
      select: { id: true, status: true, createdAt: true },
    })

    const orderCreatedAt = new Map(orders.map(o => [o.id, o.createdAt]))
    const orderStatus = new Map(orders.map(o => [o.id, o.status]))
    const validStatuses = ['confirmed', 'processing', 'shipped', 'partially_delivered', 'delivered', 'closed']

    let minDate: Date | null = null
    let maxDate: Date | null = null
    if (from) minDate = new Date(from)
    if (to) { maxDate = new Date(to); maxDate.setHours(23, 59, 59, 999) }

    let revenue = 0
    let quantity = 0
    let cogs = 0
    let grossProfit = 0
    let incompleteCount = 0
    const byProduct = new Map<string, { productId: string; name: string; revenue: number; qty: number; cogs: number; profit: number; marginSum: number; marginCount: number; incomplete: number }>()

    for (const item of items) {
      const status = orderStatus.get(item.orderId)
      if (!status || !validStatuses.includes(status)) continue

      const createdAt = orderCreatedAt.get(item.orderId)
      if (createdAt && minDate && createdAt < minDate) continue
      if (createdAt && maxDate && createdAt > maxDate) continue

      const qty = item.deliveredQty || item.orderedQty || 0
      const unitPrice = item.sellingPrice ?? 0
      const cost = item.costPrice ?? null
      const lineRevenue = unitPrice * qty
      revenue += lineRevenue
      quantity += qty

      if (cost !== null && cost > 0) {
        const lineCogs = cost * qty
        const lineProfit = (unitPrice - cost) * qty
        cogs += lineCogs
        grossProfit += lineProfit
      } else {
        incompleteCount++
      }

      const key = item.productId
      const entry = byProduct.get(key) || {
        productId: item.productId,
        name: item.product?.name || '',
        revenue: 0, qty: 0, cogs: 0, profit: 0, marginSum: 0, marginCount: 0, incomplete: 0,
      }
      entry.revenue += lineRevenue
      entry.qty += qty
      if (cost !== null && cost > 0) {
        entry.cogs += cost * qty
        entry.profit += (unitPrice - cost) * qty
        if (unitPrice > 0) { entry.marginSum += ((unitPrice - cost) / unitPrice) * 100; entry.marginCount++ }
      } else {
        entry.incomplete++
      }
      byProduct.set(key, entry)
    }

    const marginPct = revenue > 0 ? (grossProfit / revenue) * 100 : null

    const byProductRows = Array.from(byProduct.values())
      .map(e => ({
        ...e,
        margin: e.marginCount > 0 ? Math.round((e.marginSum / e.marginCount) * 100) / 100 : null,
      }))
      .sort((a, b) => b.revenue - a.revenue)

    res.json({
      summary: {
        revenue: Math.round(revenue * 100) / 100,
        quantity,
        cogs: Math.round(cogs * 100) / 100,
        grossProfit: Math.round(grossProfit * 100) / 100,
        marginPct: marginPct !== null ? Math.round(marginPct * 100) / 100 : null,
        incompleteItems: incompleteCount,
        profitabilityComplete: incompleteCount === 0,
      },
      byProduct: byProductRows,
    })
  } catch (err) {
    console.error('reports/profitability error', err)
    res.status(500).json({ error: 'فشل حساب تقرير الربحية' })
  }
})

// ============================================================================
// GET /reports/deadstock -- Dead Stock / Slow-moving inventory intelligence
// ?days= (default 90) -- products with no stock movement in the last N days
// ============================================================================
router.get('/reports/deadstock', requireAuth, requirePermission('reports.view'), async (req, res) => {
  try {
    const days = Math.max(1, Number((req.query.days as string) ?? '90') || 90)
    const since = new Date(Date.now() - days * 86400000)

    const products = await prisma.product.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true, variant: true, sku: true, category: true, stock: true, costPrice: true, price: true, updatedAt: true },
      take: 10000,
    })

    const lastMoveByProduct = await prisma.inventoryLog.groupBy({
      by: ['productId'],
      where: { createdAt: { lt: since }, change: { not: 0 } },
      _max: { createdAt: true },
    })
    const lastMoveMap = new Map(lastMoveByProduct.map(l => [l.productId, l._max.createdAt]))

    const rows = products
      .map(p => {
        const lastMove = lastMoveMap.get(p.id) ?? null
        const deadDays = lastMove ? Math.floor((Date.now() - lastMove.getTime()) / 86400000) : days
        const valuation = (p.costPrice && p.costPrice > 0 ? p.costPrice : (p.price ?? 0))
        const value = p.stock > 0 ? p.stock * valuation : 0
        return { id: p.id, name: p.name, variant: p.variant, sku: p.sku, category: p.category, stock: p.stock, value: Math.round(value * 100) / 100, lastMove: lastMove?.toISOString() ?? null, daysSinceMove: deadDays }
      })
      .filter(r => r.daysSinceMove >= days)
      .sort((a, b) => b.value - a.value)

    const totalValue = rows.reduce((s, r) => s + r.value, 0)
    const summary = {
      thresholdDays: days,
      deadStockCount: rows.length,
      totalDeadStockValue: Math.round(totalValue * 100) / 100,
    }

    res.json({ summary, products: rows.slice(0, 500) })
  } catch (err) {
    console.error('reports/deadstock error', err)
    res.status(500).json({ error: 'Failed to load dead stock report' })
  }
})

// ============================================================================
// GET /reports/aging -- Inventory Aging (value/qty bucketed by days since last movement)
// ============================================================================
router.get('/reports/aging', requireAuth, requirePermission('reports.view'), async (req, res) => {
  try {
    const products = await prisma.product.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true, variant: true, sku: true, category: true, stock: true, costPrice: true, price: true },
      take: 10000,
    })

    const lastMoveByProduct = await prisma.inventoryLog.groupBy({
      by: ['productId'],
      where: { change: { not: 0 } },
      _max: { createdAt: true },
    })
    const lastMoveMap = new Map(lastMoveByProduct.map(l => [l.productId, l._max.createdAt]))

    const buckets: Array<{ key: string; label: string; from: number; to: number | null; value: number; qty: number; count: number }> = [
      { key: '30', label: '0-30', from: 0, to: 30, value: 0, qty: 0, count: 0 },
      { key: '60', label: '31-60', from: 31, to: 60, value: 0, qty: 0, count: 0 },
      { key: '90', label: '61-90', from: 61, to: 90, value: 0, qty: 0, count: 0 },
      { key: '180', label: '91-180', from: 91, to: 180, value: 0, qty: 0, count: 0 },
      { key: '365', label: '181-365', from: 181, to: 365, value: 0, qty: 0, count: 0 },
      { key: 'over', label: '365+', from: 366, to: null, value: 0, qty: 0, count: 0 },
    ]
    const bucketIndex = new Map(buckets.map((b, i) => [b.key, i]))

    for (const p of products) {
      const lastMove = lastMoveMap.get(p.id)
      const ageDays = lastMove ? Math.floor((Date.now() - lastMove.getTime()) / 86400000) : null
      const valuation = (p.costPrice && p.costPrice > 0 ? p.costPrice : (p.price ?? 0))
      const value = p.stock * valuation
      let idx = 0
      if (ageDays !== null) {
        for (let i = 0; i < buckets.length; i++) {
          const b = buckets[i]
          if (ageDays >= b.from && (b.to === null || ageDays <= b.to)) { idx = i; break }
        }
      }
      buckets[idx].value += value
      buckets[idx].qty += p.stock
      buckets[idx].count += 1
    }

    const rows = buckets.map(b => ({ ...b, value: Math.round(b.value * 100) / 100 }))
    const totalValue = rows.reduce((s, r) => s + r.value, 0)

    res.json({ totalValue: Math.round(totalValue * 100) / 100, buckets: rows })
  } catch (err) {
    console.error('reports/aging error', err)
    res.status(500).json({ error: 'Failed to load inventory aging report' })
  }
})

// ============================================================================
// GET /reports/price-variance -- Purchase price variance history
// Reads durable price_variance inventory-log records. Optional ?minPct= filter.
// ============================================================================
router.get('/reports/price-variance', requireAuth, requirePermission('reports.view'), async (req, res) => {
  try {
    const minPct = Number((req.query.minPct as string) ?? '0')
    const logs = await prisma.inventoryLog.findMany({
      where: { type: 'price_variance' },
      include: { product: { select: { name: true, variant: true, sku: true } } },
      orderBy: { createdAt: 'desc' },
      take: 500,
    })

    const rows = logs
      .map((log: any) => {
        const after = (log.afterData ?? {}) as any
        const before = (log.beforeData ?? {}) as any
        return {
          id: log.id,
          productId: log.productId,
          productName: log.product?.name || '',
          variant: log.product?.variant || null,
          sku: log.product?.sku || null,
          previousCost: before.previousCost ?? null,
          poUnitPrice: before.poUnitPrice ?? null,
          variance: after.variance ?? null,
          variancePct: after.variancePct ?? null,
          referenceId: log.referenceId ?? null,
          createdAt: log.createdAt,
          user: log.userName || null,
        }
      })
      .filter((r: any) => r.variancePct !== null && Math.abs(r.variancePct) >= minPct)
      .slice(0, 200)

    const aboveThreshold = rows.filter((r: any) => r.variancePct >= 20).length

    res.json({ count: rows.length, aboveThreshold, rows })
  } catch (err) {
    console.error('reports/price-variance error', err)
    res.status(500).json({ error: 'Failed to load price variance report' })
  }
})

export default router
