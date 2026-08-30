import { Router } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { prisma } from "../config/database";
import { AuthRequest, requireAuth, requirePermission } from "../middleware/auth";
import { calculateMargin, recordCostAdjustment } from "../services/costService";
import { getDefaultWarehouseId, setWarehouseStock } from "../utils/stockSync";

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
        { name: { contains: search, mode: "insensitive" } },
        { variant: { contains: search, mode: "insensitive" } },
        { sku: { contains: search, mode: "insensitive" } },
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
      const defaultWhId = await getDefaultWarehouseId(tx);
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
        // Sync WarehouseStock to absolute value
        await setWarehouseStock(tx, defaultWhId, updated.id, Number(stock));
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

// ── GET /api/inventory/products/:id/cost-history ─────────────────────────────
router.get("/products/:id/cost-history", requireAuth, requirePermission("products.view"), async (req: AuthRequest, res, next) => {
  try {
    const existing = await prisma.product.findUnique({ where: { id: req.params.id } });
    if (!existing) {
      res.status(404).json({ error: "Product not found" });
      return;
    }

    const history = await prisma.costHistory.findMany({
      where: { productId: req.params.id },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: {
        id: true,
        oldCost: true,
        newCost: true,
        change: true,
        reason: true,
        purchasePrice: true,
        referenceType: true,
        referenceId: true,
        userId: true,
        userName: true,
        createdAt: true,
      },
    });

    res.json({ history });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/inventory/products/:id/cost ─────────────────────────────────────
// Set an opening/adjustment cost with a documented source (e.g. Stylish catalog).
// Separation of concerns: this is a high-stakes operation (changes inventory
// valuation) so it requires the dedicated `products.setCost` permission.
router.post("/products/:id/cost", requireAuth, requirePermission("products.setCost"), async (req: AuthRequest, res, next) => {
  try {
    const { costPrice, sourceUrl, fetchedAt } = req.body as {
      costPrice?: unknown;
      sourceUrl?: unknown;
      fetchedAt?: unknown;
    };

    const price = Number(costPrice);
    if (!Number.isFinite(price) || price <= 0) {
      res.status(400).json({ error: "costPrice must be a positive number", errorAr: "التكلفة لازم تكون رقم موجب" });
      return;
    }
    if (typeof sourceUrl !== "string" || !/^https?:\/\/.+/i.test(sourceUrl.trim()) || sourceUrl.trim().length > 500) {
      res.status(400).json({ error: "sourceUrl must be a valid http(s) URL", errorAr: "رابط المصدر غير صالح" });
      return;
    }
    let fetched: Date | undefined;
    if (fetchedAt !== undefined && fetchedAt !== null) {
      const d = new Date(String(fetchedAt));
      if (Number.isNaN(d.getTime())) {
        res.status(400).json({ error: "fetchedAt is not a valid date", errorAr: "تاريخ الحصول غير صالح" });
        return;
      }
      fetched = d;
    }

    const existing = await prisma.product.findUnique({ where: { id: req.params.id } });
    if (!existing) {
      res.status(404).json({ error: "Product not found" });
      return;
    }
    if (existing.deletedAt) {
      res.status(403).json({ error: "Archived products cannot have cost updated" });
      return;
    }

    const user = req.user;
    const product = await prisma.$transaction(async (tx) => {
      const before = existing.costPrice;
      await recordCostAdjustment(
        tx,
        existing.id,
        before,
        price,
        before === null || before === undefined || before <= 0 ? "first_purchase" : "adjustment",
        {
          referenceType: "stylish",
          referenceId: sourceUrl.trim(),
          userId: user?.userId,
          userName: user?.name,
          createdAt: fetched,
        }
      );
      const updated = await tx.product.update({
        where: { id: existing.id },
        data: { costPrice: price },
      });
      return updated;
    });

    res.json({ product, message: "Cost saved with documented source" });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/inventory/products/bulk-cost-sku ────────────────────────────────
// Bulk load of documented costs (+ optional SKU rename) in a single request.
// Each item is applied in its own transaction: CostHistory (stylish source) +
// product.costPrice + product.sku. Idempotent: items whose costPrice and sku
// already match are skipped (no duplicate history rows).
router.post("/products/bulk-cost-sku", requireAuth, requirePermission("products.setCost"), async (req: AuthRequest, res, next) => {
  try {
    const items = Array.isArray((req.body as { items?: unknown }).items) ? (req.body as { items: unknown[] }).items : null;
    if (!items || items.length === 0) {
      res.status(400).json({ error: "items must be a non-empty array", errorAr: "القائمة فاضية" });
      return;
    }
    if (items.length > 2000) {
      res.status(400).json({ error: "too many items (max 2000)", errorAr: "عدد المنتجات كبير جدًا" });
      return;
    }

    const user = req.user;
    // Pre-fetch all products once.
    const ids = items.map((it: any) => String(it?.id ?? ""));
    const existing = await prisma.product.findMany({ where: { id: { in: ids } } });
    const byId = new Map(existing.map((p) => [p.id, p]));

    // Pre-fetch all skus to detect duplicates (excluding same product).
    const skuMapByProduct = new Map<string, string>();
    const skuOwners = new Map<string, string>();
    for (const p of existing) {
      if (p.sku) {
        const k = p.sku.toLowerCase();
        const owner = skuOwners.get(k);
        if (owner === undefined || owner === p.id) skuOwners.set(k, p.id);
        else skuOwners.set(k, "__dup__");
      }
    }

    const applied: { id: string; cost?: boolean; sku?: boolean }[] = [];
    const skipped: string[] = [];
    const failures: { id: string; name?: string; error: string }[] = [];

    for (const it of items as any[]) {
      const id = String(it?.id ?? "");
      const rec = it ?? {};
      const price = Number(rec.costPrice);
      const rawUrl = typeof rec.sourceUrl === "string" ? rec.sourceUrl.trim() : "";
      const rawSku = typeof rec.sku === "string" ? rec.sku.trim() : null;
      let fetched: Date | undefined;

      const prod = byId.get(id);
      if (!prod) { failures.push({ id, error: "not found" }); continue; }
      if (prod.deletedAt) { failures.push({ id, name: prod.name, error: "archived" }); continue; }
      if (!Number.isFinite(price) || price <= 0) { failures.push({ id, name: prod.name, error: "invalid costPrice" }); continue; }
      if (!/^https?:\/\/.+/i.test(rawUrl) || rawUrl.length > 500) { failures.push({ id, name: prod.name, error: "invalid sourceUrl" }); continue; }
      if (rec.fetchedAt !== undefined && rec.fetchedAt !== null) {
        const d = new Date(String(rec.fetchedAt));
        if (Number.isNaN(d.getTime())) { failures.push({ id, name: prod.name, error: "invalid fetchedAt" }); continue; }
        fetched = d;
      }
      let skuTarget: string | null = null;
      if (rawSku) {
        if (rawSku.length > 64) { failures.push({ id, name: prod.name, error: "sku too long" }); continue; }
        const k = rawSku.toLowerCase();
        const owner = skuOwners.get(k);
        if (owner !== undefined && owner !== prod.id && owner !== "__dup__" && owner !== id) {
          failures.push({ id, name: prod.name, error: `sku "${rawSku}" already used by product ${owner}` });
          continue;
        }
        skuTarget = rawSku;
      }

      const costChanged = prod.costPrice !== price;
      const skuChanged = skuTarget !== null && prod.sku !== skuTarget;
      if (!costChanged && !skuChanged) { skipped.push(id); continue; }

      const entry: { id: string; cost?: boolean; sku?: boolean } = { id };
      try {
        await prisma.$transaction(async (tx) => {
          if (costChanged) {
            await recordCostAdjustment(
              tx,
              prod.id,
              prod.costPrice,
              price,
              prod.costPrice === null || prod.costPrice === undefined || prod.costPrice <= 0 ? "first_purchase" : "adjustment",
              { referenceType: "stylish", referenceId: rawUrl, userId: user?.userId, userName: user?.name, createdAt: fetched }
            );
            await tx.product.update({ where: { id: prod.id }, data: { costPrice: price } });
            entry.cost = true;
          }
          if (skuChanged) {
            await tx.product.update({ where: { id: prod.id }, data: { sku: skuTarget } });
            entry.sku = true;
          }
        });
        applied.push(entry);
        // update in-memory maps
        if (skuChanged) {
          skuOwners.set(skuTarget!.toLowerCase(), prod.id);
          skuMapByProduct.set(prod.id, skuTarget!);
        }
      } catch (e: any) {
        failures.push({ id, name: prod.name, error: e?.message?.slice(0, 160) || "unknown" });
      }
    }

    res.json({ applied: applied.length, skipped: skipped.length, failures: failures.length, failureDetails: failures.slice(0, 100) });
  } catch (err) {
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
