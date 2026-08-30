import { Router } from "express";
import { prisma } from "../config/database";
import { AuthRequest, requireAuth, requirePermission } from "../middleware/auth";
import { createError } from "../middleware/errorHandler";
import { PERMISSIONS } from "../utils/permissions";
import { resolveClientPrice } from "../services/priceListService";

const router = Router();

export const TIERS = ["retail", "wholesale", "corporate", "vip", "customer"] as const;
export type Tier = (typeof TIERS)[number];

// GET /price-lists/resolve?clientId=&productId= — حلّ السعر الفعلي (للواجهة)
router.get("/price-lists/resolve", requireAuth, requirePermission(PERMISSIONS.PRICE_LISTS_VIEW), async (req, res, next) => {
  try {
    const { clientId, productId } = req.query as Record<string, string>;
    if (!productId) {
      res.status(400).json({ error: "productId is required" });
      return;
    }
    const resolved = await resolveClientPrice(prisma, clientId || undefined, productId);
    const product = await prisma.product.findUnique({
      where: { id: productId },
      select: { id: true, price: true, minSellingPrice: true, name: true },
    });
    if (!product) {
      res.status(404).json({ error: "Product not found" });
      return;
    }
    res.json({
      product: { id: product.id, name: product.name, basePrice: product.price ?? 0, minSellingPrice: product.minSellingPrice ?? null },
      priceList: resolved,
    });
  } catch (err) {
    next(err);
  }
});

// GET /price-lists — قائمة القوائم
router.get("/price-lists", requireAuth, requirePermission(PERMISSIONS.PRICE_LISTS_VIEW), async (req, res, next) => {
  try {
    const lists = await prisma.priceList.findMany({
      orderBy: [{ isActive: "desc" }, { createdAt: "asc" }],
      include: {
        _count: { select: { items: true } },
        client: { select: { id: true, name: true } },
        assignedClient: { select: { id: true, name: true } },
      },
    });
    res.json({ priceLists: lists.map((l: any) => ({
      ...l,
      appliedTo: l.tier === "customer" ? l.client?.name ?? null : l.assignedClient?.name ?? null,
    })) });
  } catch (err) {
    next(err);
  }
});

// GET /price-lists/:id/items — عناصر قائمة
router.get("/price-lists/:id/items", requireAuth, requirePermission(PERMISSIONS.PRICE_LISTS_VIEW), async (req, res, next) => {
  try {
    const [list, items] = await Promise.all([
      prisma.priceList.findUnique({ where: { id: req.params.id } }),
      prisma.priceListItem.findMany({
        where: { priceListId: req.params.id },
        include: { product: { select: { id: true, name: true, variant: true, sku: true, barcode: true, category: true, price: true } } },
        orderBy: { updatedAt: "desc" },
        take: 2000,
      }),
    ]);
    if (!list) {
      res.status(404).json({ error: "Price list not found" });
      return;
    }
    res.json({ list, items });
  } catch (err) {
    next(err);
  }
});

// POST /price-lists — إنشاء قائمة
router.post("/price-lists", requireAuth, requirePermission(PERMISSIONS.PRICE_LISTS_MANAGE), async (req: AuthRequest, res, next) => {
  try {
    const { name, tier, isDefault, clientId, currency, notes } = req.body as any;
    if (!name || !name.trim()) {
      res.status(400).json({ error: "Price list name is required" });
      return;
    }
    const t = (tier || "retail") as string;
    if (!TIERS.includes(t as Tier)) {
      res.status(400).json({ error: `tier must be one of: ${TIERS.join(", ")}` });
      return;
    }
    if (t === "customer" && !clientId) {
      res.status(400).json({ error: "clientId is required for a customer-specific price list" });
      return;
    }
    if (t !== "customer" && clientId) {
      res.status(400).json({ error: "clientId is only allowed on customer-tier price lists" });
      return;
    }
    if (clientId) {
      const existing = await prisma.priceList.findFirst({ where: { clientId } });
      if (existing) {
        res.status(409).json({ error: "This client already has a customer-specific price list" });
        return;
      }
      const client = await prisma.client.findUnique({ where: { id: clientId } });
      if (!client) {
        res.status(404).json({ error: "Client not found" });
        return;
      }
    }

    const created = await prisma.$transaction(async (tx) => {
      if (isDefault) {
        await tx.priceList.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
      }
      return tx.priceList.create({
        data: {
          name: name.trim(),
          tier: t,
          currency: (currency || "EGP").trim(),
          isDefault: !!isDefault,
          clientId: clientId || null,
          notes: notes?.trim() || null,
          createdBy: req.user?.userId,
        },
      });
    });
    res.status(201).json({ priceList: created });
  } catch (err) {
    next(err);
  }
});

// PATCH /price-lists/:id — تعديل قائمة
router.patch("/price-lists/:id", requireAuth, requirePermission(PERMISSIONS.PRICE_LISTS_MANAGE), async (req: AuthRequest, res, next) => {
  try {
    const existing = await prisma.priceList.findUnique({ where: { id: req.params.id } });
    if (!existing) {
      res.status(404).json({ error: "Price list not found" });
      return;
    }
    const { name, tier, isDefault, currency, notes, isActive } = req.body as any;
    if (tier !== undefined && !TIERS.includes(tier as Tier)) {
      res.status(400).json({ error: `tier must be one of: ${TIERS.join(", ")}` });
      return;
    }
    const data: any = {};
    if (name !== undefined) data.name = name.trim();
    if (tier !== undefined) data.tier = tier;
    if (currency !== undefined) data.currency = currency.trim();
    if (notes !== undefined) data.notes = notes?.trim() || null;
    if (isActive !== undefined) data.isActive = !!isActive;
    if (isDefault !== undefined) data.isDefault = !!isDefault;

    const updated = await prisma.$transaction(async (tx) => {
      if (data.isDefault) {
        await tx.priceList.updateMany({ where: { isDefault: true, id: { not: existing.id } }, data: { isDefault: false } });
      }
      return tx.priceList.update({ where: { id: existing.id }, data });
    });
    res.json({ priceList: updated });
  } catch (err) {
    next(err);
  }
});

// DELETE /price-lists/:id — Soft deactivate + فك الارتباطات
router.delete("/price-lists/:id", requireAuth, requirePermission(PERMISSIONS.PRICE_LISTS_MANAGE), async (req, res, next) => {
  try {
    const existing = await prisma.priceList.findUnique({ where: { id: req.params.id } });
    if (!existing) {
      res.status(404).json({ error: "Price list not found" });
      return;
    }
    await prisma.$transaction(async (tx) => {
      await tx.client.updateMany({ where: { priceListId: existing.id }, data: { priceListId: null } });
      await tx.priceList.update({ where: { id: existing.id }, data: { isActive: false } });
    });
    res.json({ message: "Price list deactivated", soft: true });
  } catch (err) {
    next(err);
  }
});

// PUT /price-lists/:id/items — استبدال/تحديث الأسعار بشكل جماعي
router.put("/price-lists/:id/items", requireAuth, requirePermission(PERMISSIONS.PRICE_LISTS_MANAGE), async (req: AuthRequest, res, next) => {
  try {
    const list = await prisma.priceList.findUnique({ where: { id: req.params.id } });
    if (!list) {
      res.status(404).json({ error: "Price list not found" });
      return;
    }
    const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];
    if (rawItems.length === 0) {
      res.status(400).json({ error: "items array is required" });
      return;
    }
    const results = await prisma.$transaction(async (tx) => {
      const out: Array<{ productId: string; price: number; updated: boolean }> = [];
      for (const it of rawItems) {
        const productId = String(it.productId);
        const price = Number(it.price);
        if (!productId || !Number.isFinite(price) || price < 0) {
          throw createError(`Invalid product/price entry: ${JSON.stringify(it)}`, 400);
        }
        const product = await tx.product.findUnique({ where: { id: productId }, select: { id: true } });
        if (!product) throw createError(`Unknown productId: ${productId}`, 404);
        const existingItem = await tx.priceListItem.findUnique({
          where: { priceListId_productId: { priceListId: list.id, productId } },
        });
        if (existingItem) {
          await tx.priceListItem.update({
            where: { id: existingItem.id },
            data: { price, minPrice: it.minPrice !== undefined ? Number(it.minPrice) : existingItem.minPrice, updatedBy: req.user?.userId },
          });
          out.push({ productId, price, updated: true });
        } else {
          await tx.priceListItem.create({
            data: { priceListId: list.id, productId, price, minPrice: it.minPrice !== undefined ? Number(it.minPrice) : null, updatedBy: req.user?.userId },
          });
          out.push({ productId, price, updated: false });
        }
      }
      return out;
    });
    res.json({ message: `Upserted ${results.length} items`, items: results });
  } catch (err) {
    next(err);
  }
});

// DELETE /price-lists/:id/items/:productId — حذف عنصر من قائمة
router.delete("/price-lists/:id/items/:productId", requireAuth, requirePermission(PERMISSIONS.PRICE_LISTS_MANAGE), async (req, res, next) => {
  try {
    const existing = await prisma.priceListItem.findUnique({
      where: { priceListId_productId: { priceListId: req.params.id, productId: req.params.productId } },
    });
    if (!existing) {
      res.status(404).json({ error: "Price list item not found" });
      return;
    }
    await prisma.priceListItem.delete({ where: { id: existing.id } });
    res.json({ message: "Price list item removed" });
  } catch (err) {
    next(err);
  }
});

// GET /price-lists/tiers — الخيارات المتاحة (للعمليات) — بمنطق view
router.get("/price-lists/tiers", requireAuth, requirePermission(PERMISSIONS.PRICE_LISTS_VIEW), (_req, res) => {
  res.json({ tiers: TIERS });
});

export default router;