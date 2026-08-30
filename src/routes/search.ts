import { Router } from "express";
import { prisma } from "../config/database";
import { requireAuth, requirePermission } from "../middleware/auth";

const router = Router();

//=============================================================================
// GET /api/inventory/search?q=...  -- Global Search across all major entities
// Returns bounded, typed results so the frontend Ctrl+K palette can deep-link.
//=============================================================================
router.get("/search", requireAuth, requirePermission("reports.view"), async (req, res) => {
  try {
    const q = ((req.query.q as string) ?? "").trim();
    if (!q) {
      res.json({ query: q, results: [] });
      return;
    }
    const look = { contains: q, mode: "insensitive" as const };

    const [products, suppliers, clients, purchaseOrders, salesOrders, transfers, returns, stocktakes, reservations, warehouses] =
      await Promise.all([
        prisma.product.findMany({
          where: { deletedAt: null, OR: [{ name: look }, { sku: look }, { barcode: look }, { variant: look }] },
          select: { id: true, name: true, variant: true, sku: true, barcode: true, category: true },
          take: 8,
        }),
        prisma.supplier.findMany({
          where: { OR: [{ name: look }, { phone: look }, { email: look }] },
          select: { id: true, name: true, phone: true },
          take: 6,
        }),
        prisma.client.findMany({
          where: { OR: [{ name: look }, { phone: look }, { email: look }] },
          select: { id: true, name: true, phone: true },
          take: 6,
        }),
        prisma.purchaseOrder.findMany({
          where: { deletedAt: null, orderNumber: look },
          select: { id: true, orderNumber: true, status: true },
          take: 6,
        }),
        prisma.salesOrder.findMany({
          where: { deletedAt: null, orderNumber: look },
          select: { id: true, orderNumber: true, status: true },
          take: 6,
        }),
        prisma.transfer.findMany({
          where: { deletedAt: null, transferNumber: look },
          select: { id: true, transferNumber: true, status: true },
          take: 6,
        }),
        prisma.returnOrder.findMany({
          where: { deletedAt: null, OR: [{ returnNumber: look }, { sourceNumber: look }] },
          select: { id: true, returnNumber: true, status: true, type: true },
          take: 6,
        }),
        prisma.stocktakeSession.findMany({
          where: { deletedAt: null, name: look },
          select: { id: true, name: true, status: true },
          take: 6,
        }),
        prisma.reservation.findMany({
          where: { deletedAt: null, status: "active" },
          select: { id: true, productId: true, clientId: true, quantity: true },
          take: 0,
        }),
        prisma.warehouse.findMany({
          where: { deletedAt: null, OR: [{ name: look }, { type: look }] },
          select: { id: true, name: true, type: true },
          take: 6,
        }),
      ]);

    const results: Array<{
      type: string;
      id: string;
      label: string;
      subtitle?: string;
      href: string;
    }> = [];

    for (const p of products) {
      results.push({
        type: "product",
        id: p.id,
        label: p.name,
        subtitle: [p.variant, p.sku, p.barcode, p.category].filter(Boolean).join(" · ") || undefined,
        href: `/products/${p.id}`,
      });
    }
    for (const s of suppliers) {
      results.push({ type: "supplier", id: s.id, label: s.name, subtitle: s.phone || undefined, href: `/suppliers/${s.id}` });
    }
    for (const c of clients) {
      results.push({ type: "client", id: c.id, label: c.name, subtitle: c.phone || undefined, href: `/clients/${c.id}` });
    }
    for (const o of purchaseOrders) {
      results.push({ type: "purchase_order", id: o.id, label: o.orderNumber, subtitle: o.status, href: `/purchase-orders?highlight=${o.id}` });
    }
    for (const o of salesOrders) {
      results.push({ type: "sales_order", id: o.id, label: o.orderNumber, subtitle: o.status, href: `/sales-orders?highlight=${o.id}` });
    }
    for (const t of transfers) {
      results.push({ type: "transfer", id: t.id, label: t.transferNumber, subtitle: t.status, href: `/transfers?highlight=${t.id}` });
    }
    for (const r of returns) {
      results.push({ type: "return", id: r.id, label: r.returnNumber, subtitle: `${r.type} · ${r.status}`, href: `/returns?highlight=${r.id}` });
    }
    for (const st of stocktakes) {
      results.push({ type: "stocktake", id: st.id, label: st.name, subtitle: st.status, href: `/stocktake?highlight=${st.id}` });
    }
    for (const w of warehouses) {
      results.push({ type: "warehouse", id: w.id, label: w.name, subtitle: w.type, href: `/warehouses?highlight=${w.id}` });
    }
    void reservations;

    res.json({ query: q, results });
  } catch (err) {
    console.error("search error", err);
    res.status(500).json({ error: "Search failed" });
  }
});

export default router;
