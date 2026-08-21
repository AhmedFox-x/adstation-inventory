import { Router } from "express";
import { prisma } from "../config/database";
import { requireAuth, requirePermission, AuthRequest } from "../middleware/auth";

const router = Router();

function metaOf(req: AuthRequest) {
  return {
    userId: req.user?.userId || "",
    name: req.user?.name || req.user?.email || "",
    role: req.user?.role,
  };
}

// ── GET /api/inventory/warehouses ─────────────────────────────────────────────
router.get("/warehouses", requireAuth, async (req, res) => {
  try {
    const { includeArchived = "false" } = req.query as Record<string, string>;
    const where: any = {};
    if (includeArchived !== "true") {
      where.deletedAt = null;
      where.isActive = true;
    }

    const warehouses = await prisma.warehouse.findMany({
      where,
      orderBy: { name: "asc" },
      include: {
        _count: { select: { stocks: true } },
      },
    });

    const result = await Promise.all(
      warehouses.map(async (w) => {
        const stockAgg = await prisma.warehouseStock.aggregate({
          where: { warehouseId: w.id },
          _sum: { quantity: true, reservedQuantity: true },
        });
        const productCount = await prisma.warehouseStock.count({
          where: { warehouseId: w.id, quantity: { gt: 0 } },
        });
        return {
          id: w.id,
          name: w.name,
          type: w.type,
          description: w.description,
          isActive: w.isActive,
          deletedAt: w.deletedAt,
          deletedBy: w.deletedBy,
          createdAt: w.createdAt,
          updatedAt: w.updatedAt,
          productCount,
          totalQuantity: stockAgg._sum.quantity || 0,
          totalReserved: stockAgg._sum.reservedQuantity || 0,
        };
      })
    );

    res.json({ warehouses: result });
  } catch (err: any) {
    console.error("[Warehouses List] Error:", err?.message || err);
    if (!res.headersSent) res.status(500).json({ error: "Failed to list warehouses" });
  }
});

// ── GET /api/inventory/warehouses/:id/stock ───────────────────────────────────
router.get("/warehouses/:id/stock", requireAuth, async (req, res) => {
  try {
    const warehouse = await prisma.warehouse.findUnique({ where: { id: req.params.id } });
    if (!warehouse) { res.status(404).json({ error: "Warehouse not found" }); return; }

    const items = await prisma.warehouseStock.findMany({
      where: { warehouseId: req.params.id, quantity: { gt: 0 } },
      include: { product: { select: { id: true, name: true, sku: true, unit: true, stock: true, reservedStock: true } } },
      orderBy: { product: { name: "asc" } },
    });

    res.json({
      warehouse: { id: warehouse.id, name: warehouse.name, type: warehouse.type },
      items: items.map((i) => ({
        productId: i.productId,
        name: i.product.name,
        sku: i.product.sku,
        unit: i.product.unit,
        quantity: i.quantity,
        reservedQuantity: i.reservedQuantity,
      })),
    });
  } catch (err: any) {
    console.error("[Warehouse Stock] Error:", err?.message || err);
    if (!res.headersSent) res.status(500).json({ error: "Failed to get warehouse stock" });
  }
});

// ── POST /api/inventory/warehouses ────────────────────────────────────────────
router.post("/warehouses", requireAuth, requirePermission("warehouses.create"), async (req: any, res) => {
  try {
    const { name, type = "GENERAL", description } = req.body;
    if (!name?.trim()) { res.status(400).json({ error: "Name is required" }); return; }

    const existing = await prisma.warehouse.findUnique({ where: { name: name.trim() } });
    if (existing) { res.status(409).json({ error: "A warehouse with this name already exists" }); return; }

    const warehouse = await prisma.warehouse.create({
      data: { name: name.trim(), type, description: description || null },
    });

    res.status(201).json({ warehouse });
  } catch (err: any) {
    console.error("[Warehouse Create] Error:", err?.message || err);
    if (!res.headersSent) res.status(500).json({ error: "Failed to create warehouse" });
  }
});

// ── PATCH /api/inventory/warehouses/:id ───────────────────────────────────────
router.patch("/warehouses/:id", requireAuth, requirePermission("warehouses.edit"), async (req: any, res) => {
  try {
    const existing = await prisma.warehouse.findUnique({ where: { id: req.params.id } });
    if (!existing) { res.status(404).json({ error: "Warehouse not found" }); return; }

    const { name, description } = req.body;
    const updateData: any = {};
    if (name !== undefined) {
      if (!name.trim()) { res.status(400).json({ error: "Name cannot be empty" }); return; }
      const dup = await prisma.warehouse.findFirst({ where: { name: name.trim(), id: { not: req.params.id } } });
      if (dup) { res.status(409).json({ error: "A warehouse with this name already exists" }); return; }
      updateData.name = name.trim();
    }
    if (description !== undefined) updateData.description = description || null;

    const warehouse = await prisma.warehouse.update({ where: { id: req.params.id }, data: updateData });
    res.json({ warehouse });
  } catch (err: any) {
    console.error("[Warehouse Update] Error:", err?.message || err);
    if (!res.headersSent) res.status(500).json({ error: "Failed to update warehouse" });
  }
});

// ── PATCH /api/inventory/warehouses/:id/archive ──────────────────────────────
router.patch("/warehouses/:id/archive", requireAuth, requirePermission("warehouses.edit"), async (req: any, res) => {
  try {
    const existing = await prisma.warehouse.findUnique({ where: { id: req.params.id } });
    if (!existing) { res.status(404).json({ error: "Warehouse not found" }); return; }

    const { isActive } = req.body;
    const meta = metaOf(req);

    if (isActive === true) {
      const warehouse = await prisma.warehouse.update({
        where: { id: req.params.id },
        data: { isActive: true, deletedAt: null, deletedBy: null },
      });
      res.json({ warehouse, archived: false });
    } else {
      const warehouse = await prisma.warehouse.update({
        where: { id: req.params.id },
        data: { isActive: false, deletedAt: new Date(), deletedBy: meta.userId },
      });
      res.json({ warehouse, archived: true });
    }
  } catch (err: any) {
    console.error("[Warehouse Archive] Error:", err?.message || err);
    if (!res.headersSent) res.status(500).json({ error: "Failed to archive warehouse" });
  }
});

// ── GET /api/inventory/warehouses/:id — detail ─────────────────────────────────
router.get("/warehouses/:id", requireAuth, async (req, res) => {
  try {
    const warehouse = await prisma.warehouse.findUnique({ where: { id: req.params.id } });
    if (!warehouse) { res.status(404).json({ error: "Warehouse not found" }); return; }

    const stockAgg = await prisma.warehouseStock.aggregate({
      where: { warehouseId: warehouse.id },
      _sum: { quantity: true, reservedQuantity: true },
      _count: true,
    });
    const productCount = await prisma.warehouseStock.count({
      where: { warehouseId: warehouse.id, quantity: { gt: 0 } },
    });
    const lowStockProducts = await prisma.warehouseStock.findMany({
      where: { warehouseId: warehouse.id, quantity: { gt: 0 }, reservedQuantity: { gt: 0 } },
      include: { product: { select: { name: true, minStock: true } } },
      orderBy: { reservedQuantity: "desc" },
      take: 10,
    });
    const recentTransfers = await prisma.transfer.findMany({
      where: { OR: [{ fromWarehouseId: warehouse.id }, { toWarehouseId: warehouse.id }] },
      include: {
        fromWarehouse: { select: { name: true } },
        toWarehouse: { select: { name: true } },
        items: { select: { quantity: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 10,
    });
    const recentLogs = await prisma.inventoryLog.findMany({
      where: { warehouseId: warehouse.id },
      include: { product: { select: { name: true, sku: true } } },
      orderBy: { createdAt: "desc" },
      take: 20,
    });

    const stockValue = await prisma.warehouseStock.findMany({
      where: { warehouseId: warehouse.id, quantity: { gt: 0 } },
      include: { product: { select: { price: true } } },
    });
    const totalValue = stockValue.reduce((sum, ws) => sum + ws.quantity * (ws.product.price || 0), 0);

    res.json({
      warehouse: {
        ...warehouse,
        productCount,
        totalQuantity: stockAgg._sum.quantity || 0,
        totalReserved: stockAgg._sum.reservedQuantity || 0,
        totalValue,
        lowStockProducts: lowStockProducts.map((ws) => ({
          productId: ws.productId,
          name: ws.product.name,
          minStock: ws.product.minStock,
          quantity: ws.quantity,
          reservedQuantity: ws.reservedQuantity,
        })),
        recentTransfers: recentTransfers.map((tr) => ({
          id: tr.id,
          transferNumber: tr.transferNumber,
          status: tr.status,
          fromName: tr.fromWarehouse.name,
          toName: tr.toWarehouse.name,
          totalQuantity: tr.items.reduce((sum, i) => sum + i.quantity, 0),
          createdAt: tr.createdAt,
        })),
        recentLogs: recentLogs.map((l) => ({
          id: l.id,
          type: l.type,
          productName: l.product.name,
          productSku: l.product.sku,
          change: l.change,
          oldStock: l.oldStock,
          newStock: l.newStock,
          userName: l.userName,
          createdAt: l.createdAt,
        })),
      },
    });
  } catch (err: any) {
    console.error("[Warehouse Detail]", err?.message || err);
    if (!res.headersSent) res.status(500).json({ error: "Failed to get warehouse detail" });
  }
});

// ── GET /api/inventory/products/:id/stock — stock across all warehouses ────────
router.get("/products/:id/stock", requireAuth, async (req, res) => {
  try {
    const product = await prisma.product.findUnique({
      where: { id: req.params.id },
      select: { id: true, name: true, sku: true, unit: true, price: true, imageUrl: true, stock: true, reservedStock: true, quarantineStock: true },
    });
    if (!product) { res.status(404).json({ error: "Product not found" }); return; }

    const warehouseStocks = await prisma.warehouseStock.findMany({
      where: { productId: req.params.id, quantity: { gt: 0 } },
      include: { warehouse: { select: { id: true, name: true, type: true } } },
      orderBy: { quantity: "desc" },
    });

    res.json({
      product,
      warehouses: warehouseStocks.map((ws) => ({
        warehouseId: ws.warehouse.id,
        warehouseName: ws.warehouse.name,
        warehouseType: ws.warehouse.type,
        quantity: ws.quantity,
        reservedQuantity: ws.reservedQuantity,
        available: ws.quantity - ws.reservedQuantity,
      })),
      totalPhysical: product.stock,
      totalReserved: product.reservedStock,
      totalAvailable: product.stock - product.reservedStock,
    });
  } catch (err: any) {
    console.error("[Product Stock]", err?.message || err);
    if (!res.headersSent) res.status(500).json({ error: "Failed to get product stock" });
  }
});

export default router;
