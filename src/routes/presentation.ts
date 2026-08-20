import { Router } from "express";
import { prisma } from "../config/database";
import { requireAuth, requirePermission, AuthRequest } from "../middleware/auth";

const router = Router();

// ── GET /api/inventory/presentation/showroom — Public endpoint ───────────────
router.get("/presentation/showroom", async (_req, res) => {
  try {
    const settings = await prisma.presentationSetting.findMany({
      where: { entityType: "product" },
      orderBy: { showroomSort: "asc" },
    });

    const productIds = settings
      .filter((s) => s.showroomVisible)
      .map((s) => s.entityId);

    const products = await prisma.product.findMany({
      where: {
        id: { in: productIds },
        deletedAt: null,
      },
    });

    const productMap = new Map(products.map((p) => [p.id, p]));

    const visibleProducts = settings
      .filter((s) => s.showroomVisible && productMap.has(s.entityId))
      .map((s) => ({
        ...s,
        product: productMap.get(s.entityId),
      }));

    res.json({ products: visibleProducts });
  } catch (err: any) {
    console.error("[Presentation Showroom] Error:", err?.message || err);
    if (!res.headersSent)
      res.status(500).json({ error: "Failed to load showroom settings" });
  }
});

// ── GET /api/inventory/presentation — list all settings ──────────────────────
router.get(
  "/presentation",
  requireAuth,
  requirePermission("presentation.view"),
  async (req, res) => {
    try {
      const { entityType } = req.query;
      const where: any = {};
      if (entityType && typeof entityType === "string") {
        where.entityType = entityType;
      }

      const settings = await prisma.presentationSetting.findMany({
        where,
        orderBy: [{ entityType: "asc" }, { showroomSort: "asc" }],
      });

      res.json({ settings });
    } catch (err: any) {
      console.error("[Presentation List] Error:", err?.message || err);
      if (!res.headersSent)
        res.status(500).json({ error: "Failed to list presentation settings" });
    }
  }
);

// ── GET /api/inventory/presentation/:entityType/:entityId ────────────────────
router.get(
  "/presentation/:entityType/:entityId",
  requireAuth,
  requirePermission("presentation.view"),
  async (req, res) => {
    try {
      const { entityType, entityId } = req.params;
      const setting = await prisma.presentationSetting.findUnique({
        where: { entityType_entityId: { entityType, entityId } },
      });

      if (!setting) {
        return res
          .status(404)
          .json({ error: "Presentation setting not found" });
      }

      res.json({ setting });
    } catch (err: any) {
      console.error("[Presentation Get] Error:", err?.message || err);
      if (!res.headersSent)
        res.status(500).json({ error: "Failed to get presentation setting" });
    }
  }
);

// ── PUT /api/inventory/presentation — upsert one or batch ────────────────────
router.put(
  "/presentation",
  requireAuth,
  requirePermission("presentation.edit"),
  async (req, res) => {
    try {
      const { items, ...singleItem } = req.body;

      if (items && Array.isArray(items)) {
        const results = await Promise.all(
          items.map((item: any) =>
            prisma.presentationSetting.upsert({
              where: {
                entityType_entityId: {
                  entityType: item.entityType,
                  entityId: item.entityId,
                },
              },
              create: {
                entityType: item.entityType,
                entityId: item.entityId,
                showroomVisible: item.showroomVisible ?? true,
                showroomSort: item.showroomSort ?? 0,
                showroomFeatured: item.showroomFeatured ?? false,
                catalogIncluded: item.catalogIncluded ?? true,
                catalogSort: item.catalogSort ?? 0,
                catalogFeatured: item.catalogFeatured ?? false,
                catalogHero: item.catalogHero ?? false,
                coverImage: item.coverImage ?? null,
                displayName: item.displayName ?? null,
                displayDesc: item.displayDesc ?? null,
              },
              update: {
                ...(item.showroomVisible !== undefined && {
                  showroomVisible: item.showroomVisible,
                }),
                ...(item.showroomSort !== undefined && {
                  showroomSort: item.showroomSort,
                }),
                ...(item.showroomFeatured !== undefined && {
                  showroomFeatured: item.showroomFeatured,
                }),
                ...(item.catalogIncluded !== undefined && {
                  catalogIncluded: item.catalogIncluded,
                }),
                ...(item.catalogSort !== undefined && {
                  catalogSort: item.catalogSort,
                }),
                ...(item.catalogFeatured !== undefined && {
                  catalogFeatured: item.catalogFeatured,
                }),
                ...(item.catalogHero !== undefined && {
                  catalogHero: item.catalogHero,
                }),
                ...(item.coverImage !== undefined && {
                  coverImage: item.coverImage,
                }),
                ...(item.displayName !== undefined && {
                  displayName: item.displayName,
                }),
                ...(item.displayDesc !== undefined && {
                  displayDesc: item.displayDesc,
                }),
              },
            })
          )
        );

        return res.json({ count: results.length, settings: results });
      }

      if (!singleItem.entityType || !singleItem.entityId) {
        return res
          .status(400)
          .json({ error: "entityType and entityId are required" });
      }

      const setting = await prisma.presentationSetting.upsert({
        where: {
          entityType_entityId: {
            entityType: singleItem.entityType,
            entityId: singleItem.entityId,
          },
        },
        create: {
          entityType: singleItem.entityType,
          entityId: singleItem.entityId,
          showroomVisible: singleItem.showroomVisible ?? true,
          showroomSort: singleItem.showroomSort ?? 0,
          showroomFeatured: singleItem.showroomFeatured ?? false,
          catalogIncluded: singleItem.catalogIncluded ?? true,
          catalogSort: singleItem.catalogSort ?? 0,
          catalogFeatured: singleItem.catalogFeatured ?? false,
          catalogHero: singleItem.catalogHero ?? false,
          coverImage: singleItem.coverImage ?? null,
          displayName: singleItem.displayName ?? null,
          displayDesc: singleItem.displayDesc ?? null,
        },
        update: {
          ...(singleItem.showroomVisible !== undefined && {
            showroomVisible: singleItem.showroomVisible,
          }),
          ...(singleItem.showroomSort !== undefined && {
            showroomSort: singleItem.showroomSort,
          }),
          ...(singleItem.showroomFeatured !== undefined && {
            showroomFeatured: singleItem.showroomFeatured,
          }),
          ...(singleItem.catalogIncluded !== undefined && {
            catalogIncluded: singleItem.catalogIncluded,
          }),
          ...(singleItem.catalogSort !== undefined && {
            catalogSort: singleItem.catalogSort,
          }),
          ...(singleItem.catalogFeatured !== undefined && {
            catalogFeatured: singleItem.catalogFeatured,
          }),
          ...(singleItem.catalogHero !== undefined && {
            catalogHero: singleItem.catalogHero,
          }),
          ...(singleItem.coverImage !== undefined && {
            coverImage: singleItem.coverImage,
          }),
          ...(singleItem.displayName !== undefined && {
            displayName: singleItem.displayName,
          }),
          ...(singleItem.displayDesc !== undefined && {
            displayDesc: singleItem.displayDesc,
          }),
        },
      });

      res.json({ setting });
    } catch (err: any) {
      console.error("[Presentation Upsert] Error:", err?.message || err);
      if (!res.headersSent)
        res.status(500).json({ error: "Failed to upsert presentation setting" });
    }
  }
);

// ── DELETE /api/inventory/presentation/:id — delete setting ──────────────────
router.delete(
  "/presentation/:id",
  requireAuth,
  requirePermission("presentation.edit"),
  async (req, res) => {
    try {
      const setting = await prisma.presentationSetting.findUnique({
        where: { id: req.params.id },
      });

      if (!setting) {
        return res
          .status(404)
          .json({ error: "Presentation setting not found" });
      }

      await prisma.presentationSetting.delete({
        where: { id: req.params.id },
      });

      res.json({ message: "Presentation setting deleted" });
    } catch (err: any) {
      console.error("[Presentation Delete] Error:", err?.message || err);
      if (!res.headersSent)
        res.status(500).json({ error: "Failed to delete presentation setting" });
    }
  }
);

export default router;
