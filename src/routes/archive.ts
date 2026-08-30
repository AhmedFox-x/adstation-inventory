/**
 * archive.ts — Generic Archive (Soft Delete) + Restore for Owner-only
 *
 * POST /archive/:entity/:id     — sets deletedAt + deletedBy
 * POST /restore/:entity/:id     — clears deletedAt + deletedBy
 * GET  /archived/:entity        — lists archived records
 *
 * Entities supported: purchaseOrder, stocktakeSession, withdrawalPermit, supplyPermit, reservation, transfer, returnOrder
 */

import { Router } from "express";
import { prisma } from "../config/database";
import { requireAuth, requirePermission, AuthRequest } from "../middleware/auth";

const router = Router();

const ENTITY_CONFIG: Record<string, { label: string; findUnique: string }> = {
  purchaseOrder:      { label: "أذن شراء",         findUnique: "purchaseOrder" },
  salesOrder:         { label: "أذن بيع",          findUnique: "salesOrder" },
  stocktakeSession:   { label: "جلسة جرد",         findUnique: "stocktakeSession" },
  withdrawalPermit:   { label: "إذن صرف",          findUnique: "withdrawalPermit" },
  supplyPermit:       { label: "إذن توريد",        findUnique: "supplyPermit" },
  reservation:        { label: "حجز",              findUnique: "reservation" },
  transfer:           { label: "نقل",              findUnique: "transfer" },
  returnOrder:        { label: "مرتجع",            findUnique: "returnOrder" },
};

const ENTITY_TABLES: Record<string, string> = {
  purchaseOrder: "PurchaseOrder",
  stocktakeSession: "StocktakeSession",
  withdrawalPermit: "WithdrawalPermit",
  supplyPermit: "SupplyPermit",
  reservation: "Reservation",
  transfer: "Transfer",
  returnOrder: "ReturnOrder",
};

// ── POST /api/inventory/archive/:entity/:id ──────────────────────────────────
router.post("/archive/:entity/:id", requireAuth, requirePermission("stocktake.approve"), async (req: AuthRequest, res, next) => {
  try {
    const { entity, id } = req.params;
    const config = ENTITY_CONFIG[entity];
    if (!config) {
      res.status(400).json({ error: `Unknown entity: ${entity}. Supported: ${Object.keys(ENTITY_CONFIG).join(", ")}` });
      return;
    }

    // @ts-ignore — dynamic model access
    const record = await prisma[config.findUnique].findUnique({ where: { id } });
    if (!record) {
      res.status(404).json({ error: `${config.label} not found` });
      return;
    }
    if (record.deletedAt) {
      res.status(400).json({ error: `${config.label} is already archived` });
      return;
    }

    // @ts-ignore — dynamic model access
    const updated = await prisma[config.findUnique].update({
      where: { id },
      data: {
        deletedAt: new Date(),
        deletedBy: req.user?.userId || "unknown",
      },
    });

    res.json({ message: `تم أرشفة ${config.label} بنجاح`, id, archived: true });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/inventory/restore/:entity/:id ──────────────────────────────────
router.post("/restore/:entity/:id", requireAuth, requirePermission("stocktake.approve"), async (req: AuthRequest, res, next) => {
  try {
    const { entity, id } = req.params;
    const config = ENTITY_CONFIG[entity];
    if (!config) {
      res.status(400).json({ error: `Unknown entity: ${entity}. Supported: ${Object.keys(ENTITY_CONFIG).join(", ")}` });
      return;
    }

    // @ts-ignore — dynamic model access
    const record = await prisma[config.findUnique].findUnique({ where: { id } });
    if (!record) {
      res.status(404).json({ error: `${config.label} not found` });
      return;
    }
    if (!record.deletedAt) {
      res.status(400).json({ error: `${config.label} is not archived` });
      return;
    }

    // @ts-ignore — dynamic model access
    const updated = await prisma[config.findUnique].update({
      where: { id },
      data: {
        deletedAt: null,
        deletedBy: null,
      },
    });

    res.json({ message: `تمت استعادة ${config.label} بنجاح`, id, archived: false });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/inventory/archived/:entity ──────────────────────────────────────
router.get("/archived/:entity", requireAuth, requirePermission("stocktake.approve"), async (req: AuthRequest, res, next) => {
  try {
    const { entity } = req.params;
    const { page = "1", limit = "20" } = req.query as Record<string, string>;
    const config = ENTITY_CONFIG[entity];
    if (!config) {
      res.status(400).json({ error: `Unknown entity: ${entity}. Supported: ${Object.keys(ENTITY_CONFIG).join(", ")}` });
      return;
    }

    const take = Math.min(Number(limit) || 20, 100);
    const skip = (Math.max(Number(page) || 1, 1) - 1) * take;

    // @ts-ignore — dynamic model access
    const [records, total] = await Promise.all([
      prisma[config.findUnique].findMany({
        where: { deletedAt: { not: null } },
        orderBy: { deletedAt: "desc" },
        skip,
        take,
      }),
      prisma[config.findUnique].count({
        where: { deletedAt: { not: null } },
      }),
    ]);

    res.json({
      data: records,
      pagination: {
        page: Number(page) || 1,
        limit: take,
        total,
        pages: Math.ceil(total / take),
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
