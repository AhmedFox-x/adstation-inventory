import { Router } from "express";
import { prisma } from "../config/database";
import { AuthRequest, requireAuth } from "../middleware/auth";

const router = Router();

// ── GET /api/inventory/stats ──────────────────────────────────────────────────
router.get("/stats", requireAuth, async (_req, res, next) => {
  try {
    const products = await prisma.product.findMany();
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const todayLogs = await prisma.inventoryLog.findMany({
      where: { createdAt: { gte: todayStart } },
    });

    const totalItems = products.reduce((s, p) => s + p.stock, 0);
    const totalProducts = products.length;
    const lowStock = products.filter((p) => p.stock > 0 && p.stock < p.minStock).length;
    const outOfStock = products.filter((p) => p.stock === 0).length;
    const todayMoves = todayLogs.length;
    const todayUp = todayLogs.filter((l) => l.change > 0).reduce((s, l) => s + l.change, 0);
    const todayDown = todayLogs
      .filter((l) => l.change < 0)
      .reduce((s, l) => s + Math.abs(l.change), 0);

    const recentLogs = await prisma.inventoryLog.findMany({
      take: 10,
      orderBy: { createdAt: "desc" },
      include: { product: { select: { name: true } } },
    });

    // Resolve permit numbers for recent logs
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
          id: l.id,
          type: l.type,
          permitNumber,
          productId: l.productId,
          productName: l.product.name,
          oldStock: l.oldStock,
          newStock: l.newStock,
          change: l.change,
          clientName: l.clientName,
          salesName: l.salesName,
          notes: l.notes === "via scan" ? null : l.notes,
          createdAt: l.createdAt,
        };
      })
    );

    res.json({
      totalItems,
      totalProducts,
      lowStock,
      outOfStock,
      todayMoves,
      todayUp,
      todayDown,
      recentLogs: recentLogsWithPermit,
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/inventory/products ───────────────────────────────────────────────
router.get("/products", requireAuth, async (req, res, next) => {
  try {
    const { search, category, page = "1", limit = "50" } = req.query as Record<string, string>;
    const where: any = {};

    if (search) {
      where.OR = [
        { name: { contains: search } },
        { variant: { contains: search } },
        { sku: { contains: search } },
      ];
    }
    if (category) {
      where.category = category;
    }

    const skip = (Number(page) - 1) * Number(limit);
    const take = Number(limit);

    const [products, total] = await Promise.all([
      prisma.product.findMany({ where, orderBy: { createdAt: "desc" }, skip, take }),
      prisma.product.count({ where }),
    ]);

    res.json({
      products,
      pagination: {
        page: Number(page),
        limit: take,
        total,
        pages: Math.ceil(total / take),
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/inventory/products ──────────────────────────────────────────────
router.post("/products", requireAuth, async (req, res, next) => {
  try {
    const { name, variant, stock, minStock, sku, category, price, image } = req.body;
    if (!name || !String(name).trim()) {
      res.status(400).json({ error: "Product name is required" });
      return;
    }

    const product = await prisma.product.create({
      data: {
        name: String(name).trim(),
        variant: variant || null,
        stock: Number(stock) || 0,
        minStock: Number(minStock) || 5,
        sku: sku || null,
        category: category || null,
        price: price !== undefined ? Number(price) || 0 : 0,
        image: image || null,
      },
    });

    res.status(201).json({ product });
  } catch (err: any) {
    if (err?.code === "P2002") {
      res.status(409).json({ error: "A product with this SKU already exists" });
      return;
    }
    next(err);
  }
});

// ── PATCH /api/inventory/products/:id ─────────────────────────────────────────
router.patch("/products/:id", requireAuth, async (req, res, next) => {
  try {
    const { name, variant, stock, minStock, sku, category, price, image } = req.body;
    const existing = await prisma.product.findUnique({ where: { id: req.params.id } });
    if (!existing) {
      res.status(404).json({ error: "Product not found" });
      return;
    }

    const product = await prisma.product.update({
      where: { id: req.params.id },
      data: {
        ...(name !== undefined && { name: String(name).trim() }),
        ...(variant !== undefined && { variant: variant || null }),
        ...(stock !== undefined && { stock: Number(stock) }),
        ...(minStock !== undefined && { minStock: Number(minStock) }),
        ...(sku !== undefined && { sku: sku || null }),
        ...(category !== undefined && { category: category || null }),
        ...(price !== undefined && { price: Number(price) || 0 }),
        ...(image !== undefined && { image: image || null }),
      },
    });

    res.json({ product });
  } catch (err: any) {
    if (err?.code === "P2002") {
      res.status(409).json({ error: "A product with this SKU already exists" });
      return;
    }
    next(err);
  }
});

// ── DELETE /api/inventory/products/:id ────────────────────────────────────────
router.delete("/products/:id", requireAuth, async (req, res, next) => {
  try {
    const existing = await prisma.product.findUnique({ where: { id: req.params.id } });
    if (!existing) {
      res.status(404).json({ error: "Product not found" });
      return;
    }

    // Delete related records first (SQLite doesn't enforce foreign keys by default)
    await prisma.inventoryLog.deleteMany({ where: { productId: req.params.id } });
    await prisma.withdrawalItem.deleteMany({ where: { productId: req.params.id } });
    await prisma.supplyItem.deleteMany({ where: { productId: req.params.id } });
    await prisma.product.delete({ where: { id: req.params.id } });

    res.json({ message: "Product deleted" });
  } catch (err) {
    next(err);
  }
});

export default router;
