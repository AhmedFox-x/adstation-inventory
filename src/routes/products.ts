import { Router } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { prisma } from "../config/database";
import { AuthRequest, requireAuth, requirePermission } from "../middleware/auth";
import { calculateMargin } from "../services/costService";

const router = Router();

// ── Multer config for product image uploads ──────────────────────────────────
const uploadsDir = path.resolve(__dirname, "../../public/uploads/products");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${unique}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = [".jpg", ".jpeg", ".png", ".webp", ".gif"];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  },
});

// ── POST /api/inventory/products/:id/image — upload image file ──────────────
router.post("/products/:id/image", requireAuth, requirePermission("products.edit"), upload.single("image"), async (req, res, next) => {
  try {
    const existing = await prisma.product.findUnique({ where: { id: req.params.id } });
    if (!existing) {
      res.status(404).json({ error: "Product not found" });
      return;
    }
    if (existing.deletedAt) {
      res.status(403).json({ error: "Archived products cannot be edited" });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: "No image file provided" });
      return;
    }

    // Delete old image file if it exists
    if (existing.imageUrl) {
      const oldPath = path.join(uploadsDir, path.basename(existing.imageUrl));
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }

    const imageUrl = `/uploads/products/${req.file.filename}`;
    const product = await prisma.product.update({
      where: { id: req.params.id },
      data: { imageUrl },
    });

    res.json({ product });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /api/inventory/products/:id/image — remove image ─────────────────
router.delete("/products/:id/image", requireAuth, requirePermission("products.edit"), async (req, res, next) => {
  try {
    const existing = await prisma.product.findUnique({ where: { id: req.params.id } });
    if (!existing) {
      res.status(404).json({ error: "Product not found" });
      return;
    }
    if (existing.deletedAt) {
      res.status(403).json({ error: "Archived products cannot be edited" });
      return;
    }
    if (existing.imageUrl) {
      const filePath = path.join(uploadsDir, path.basename(existing.imageUrl));
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    const product = await prisma.product.update({
      where: { id: req.params.id },
      data: { imageUrl: null },
    });
    res.json({ product });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/inventory/stats ──────────────────────────────────────────────────
router.get("/stats", requireAuth, async (_req, res, next) => {
  try {
    const products = await prisma.product.findMany({ where: { deletedAt: null } });
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const todayLogs = await prisma.inventoryLog.findMany({
      where: { createdAt: { gte: todayStart } },
    });

    const totalItems = products.reduce((s, p) => s + p.stock, 0);
    const totalProducts = products.length;
    const lowStock = products.filter((p) => p.stock > 0 && p.stock < p.minStock).length;
    const outOfStock = products.filter((p) => p.stock === 0).length;
    const totalInventoryValue = products.reduce((s, p) => {
      const valuation = p.costPrice && p.costPrice > 0 ? p.costPrice : (p.price ?? 0);
      return s + valuation * p.stock;
    }, 0);
    const productsWithCost = products.filter(p => p.costPrice && p.costPrice > 0).length;
    const productsWithoutCost = totalProducts - productsWithCost;
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

    // Batch-fetch permits to avoid N+1 queries
    const withdrawalIds = recentLogs.filter(l => l.referenceType === "withdrawal" && l.referenceId).map(l => l.referenceId!);
    const supplyIds = recentLogs.filter(l => l.referenceType === "supply" && l.referenceId).map(l => l.referenceId!);

    const withdrawalPermits = withdrawalIds.length > 0
      ? await prisma.withdrawalPermit.findMany({ where: { id: { in: withdrawalIds } }, select: { id: true, permitNumber: true, permitNumberOrig: true } })
      : [];
    const supplyPermits = supplyIds.length > 0
      ? await prisma.supplyPermit.findMany({ where: { id: { in: supplyIds } }, select: { id: true, permitNumber: true, permitNumberOrig: true } })
      : [];

    const withdrawalMap = new Map<string, any>(withdrawalPermits.map(w => [w.id, w]));
    const supplyMap = new Map<string, any>(supplyPermits.map(s => [s.id, s]));

    const recentLogsWithPermit = recentLogs.map((l) => {
      let permitNumber: string | null = null;
      if (l.referenceType === "withdrawal" && l.referenceId) {
        const w = withdrawalMap.get(l.referenceId);
        permitNumber = w?.permitNumberOrig || w?.permitNumber || null;
      } else if (l.referenceType === "supply" && l.referenceId) {
        const s = supplyMap.get(l.referenceId);
        permitNumber = s?.permitNumberOrig || s?.permitNumber || null;
      }
      return {
        id: l.id, type: l.type, permitNumber, productId: l.productId,
        productName: l.product.name, oldStock: l.oldStock, newStock: l.newStock,
        change: l.change, clientName: l.clientName, salesName: l.salesName,
        notes: l.notes === "via scan" ? null : l.notes, createdAt: l.createdAt,
      };
    });

    res.json({
      totalItems, totalProducts, lowStock, outOfStock,
      totalInventoryValue, productsWithCost, productsWithoutCost,
      todayMoves, todayUp, todayDown, recentLogs: recentLogsWithPermit,
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/inventory/products ───────────────────────────────────────────────
router.get("/products", requireAuth, async (req, res, next) => {
  try {
    const { search, category, page = "1", limit = "50", archived } = req.query as Record<string, string>;
    const where: any = archived === "true" ? {} : { deletedAt: null };

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

    const productsWithAvailable = products.map((p) => ({
      ...p,
      availableStock: p.stock - p.reservedStock,
      margin: calculateMargin(p.price ?? 0, p.costPrice ?? null),
      inventoryValue: p.costPrice ? Math.round(p.costPrice * p.stock * 100) / 100 : null,
      costStatus: (p.costPrice && p.costPrice > 0) ? "established" : "unknown" as const,
    }));

    res.json({
      products: productsWithAvailable,
      page: Number(page),
      limit: take,
      total,
      pages: Math.ceil(total / take),
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/inventory/products ──────────────────────────────────────────────
router.post("/products", requireAuth, requirePermission("products.create"), async (req, res, next) => {
  try {
    const { name, variant, stock, minStock, sku, category, price, minSellingPrice, imageUrl } = req.body;
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
        minSellingPrice: minSellingPrice !== undefined ? Number(minSellingPrice) || null : null,
        imageUrl: imageUrl || null,
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
router.patch("/products/:id", requireAuth, requirePermission("products.edit"), async (req: AuthRequest, res, next) => {
  try {
    const { name, variant, stock, minStock, sku, category, price, minSellingPrice, imageUrl } = req.body;
    // costPrice is intentionally excluded — it is calculated automatically by costService
    const existing = await prisma.product.findUnique({ where: { id: req.params.id } });
    if (!existing) {
      res.status(404).json({ error: "Product not found" });
      return;
    }
    if (existing.deletedAt) {
      res.status(403).json({ error: "Archived products cannot be edited" });
      return;
    }

    const product = await prisma.$transaction(async (tx) => {
      const updated = await tx.product.update({
        where: { id: req.params.id },
        data: {
          ...(name !== undefined && { name: String(name).trim() }),
          ...(variant !== undefined && { variant: variant || null }),
          ...(stock !== undefined && { stock: Number(stock) }),
          ...(minStock !== undefined && { minStock: Number(minStock) }),
          ...(sku !== undefined && { sku: sku || null }),
          ...(category !== undefined && { category: category || null }),
          ...(price !== undefined && { price: Number(price) || 0 }),
          ...(minSellingPrice !== undefined && { minSellingPrice: minSellingPrice !== null ? Number(minSellingPrice) : null }),
          ...(imageUrl !== undefined && { imageUrl: imageUrl || null }),
        },
      });

      // Audit trail: manual stock adjustment must leave a trace (same transaction as the change)
      if (stock !== undefined && Number(stock) !== existing.stock) {
        const user = req.user;
        await tx.inventoryLog.create({
          data: {
            type: "manual_adjust",
            productId: updated.id,
            oldStock: existing.stock,
            newStock: Number(stock),
            change: Number(stock) - existing.stock,
            userId: user?.userId,
            userName: user?.name,
            userRole: user?.role,
            entityType: "product",
            entityId: updated.id,
            notes: "تعديل يدوي للمخزون",
            beforeData: { stock: existing.stock, minStock: existing.minStock, price: existing.price, minSellingPrice: existing.minSellingPrice ?? null, costPrice: existing.costPrice ?? null },
            afterData: { stock: updated.stock, minStock: updated.minStock, price: updated.price, minSellingPrice: updated.minSellingPrice ?? null, costPrice: updated.costPrice ?? null },
          },
        });
      }

      return updated;
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
router.delete("/products/:id", requireAuth, requirePermission("products.delete"), async (req, res, next) => {
  try {
    const existing = await prisma.product.findUnique({ where: { id: req.params.id } });
    if (!existing) {
      res.status(404).json({ error: "Product not found" });
      return;
    }

    if (existing.deletedAt) {
      res.status(409).json({ error: "Product already archived" });
      return;
    }

    // Soft delete: archive the product, preserve all history (InventoryLog, items, relations).
    // The archived product is excluded from operational queries via deletedAt filter.
    await prisma.product.update({
      where: { id: req.params.id },
      data: { deletedAt: new Date() },
    });

    // Auto-cleanup: hide product from Showroom and Catalog presentations
    await prisma.presentationSetting.upsert({
      where: {
        entityType_entityId: { entityType: "product", entityId: req.params.id },
      },
      create: {
        entityType: "product",
        entityId: req.params.id,
        showroomVisible: false,
        catalogIncluded: false,
      },
      update: {
        showroomVisible: false,
        catalogIncluded: false,
      },
    });

    res.json({ message: "Product archived", archived: true });
  } catch (err) {
    next(err);
  }
});

export default router;
