/**
 * stock-intelligence.ts — Historical Stock + Incoming/Outgoing + Quarantine API
 *
 * GET  /api/inventory/stock/history/:productId       — historical stock chart data
 * GET  /api/inventory/stock/incoming                  — pending inbound PO items
 * GET  /api/inventory/stock/outgoing                  — committed outbound SO items
 * GET  /api/inventory/stock/quarantine                — quarantine list
 * POST /api/inventory/stock/quarantine/:id/release    — release quarantined stock
 */

import { Router } from "express";
import { prisma } from "../config/database";
import { requireAuth, requirePermission, AuthRequest } from "../middleware/auth";
import {
  getHistoricalStock,
  getIncomingStock,
  getOutgoingStock,
  getQuarantineList,
  releaseQuarantine,
} from "../services/stockHistory";

const router = Router();

// ── GET /api/inventory/stock/history/:productId ─────────────────────────────
router.get("/stock/history/:productId", requireAuth, requirePermission("products.view"), async (req: AuthRequest, res, next) => {
  try {
    const { productId } = req.params;
    const days = Number(req.query.days) || 30;

    const product = await prisma.product.findUnique({
      where: { id: productId },
      select: { id: true, name: true, sku: true, stock: true, deletedAt: true },
    });
    if (!product || product.deletedAt) {
      res.status(404).json({ error: "Product not found" });
      return;
    }

    const history = await getHistoricalStock(prisma, productId, Math.min(days, 365));

    res.json({
      product,
      history,
      summary: {
        currentStock: product.stock,
        daysRequested: days,
        dataPoints: history.length,
        totalIncoming: history.reduce((s, h) => s + h.incoming, 0),
        totalOutgoing: history.reduce((s, h) => s + h.outgoing, 0),
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/inventory/stock/incoming ───────────────────────────────────────
router.get("/stock/incoming", requireAuth, requirePermission("products.view"), async (req: AuthRequest, res, next) => {
  try {
    const incoming = await getIncomingStock(prisma);

    const totalPendingQty = incoming.reduce((s, i) => s + i.totalPending, 0);
    const totalPendingValue = incoming.reduce(
      (s, i) => s + i.totalPending * 0, // Would need costPrice — simplified for now
      0
    );

    res.json({
      items: incoming,
      summary: {
        totalProducts: incoming.length,
        totalPendingQty,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/inventory/stock/outgoing ───────────────────────────────────────
router.get("/stock/outgoing", requireAuth, requirePermission("products.view"), async (req: AuthRequest, res, next) => {
  try {
    const outgoing = await getOutgoingStock(prisma);

    const totalPendingQty = outgoing.reduce((s, o) => s + o.totalPending, 0);

    res.json({
      items: outgoing,
      summary: {
        totalProducts: outgoing.length,
        totalPendingQty,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/inventory/stock/quarantine ─────────────────────────────────────
router.get("/stock/quarantine", requireAuth, requirePermission("products.view"), async (req: AuthRequest, res, next) => {
  try {
    const items = await getQuarantineList(prisma);
    const totalValue = items.reduce((s, i) => s + i.totalValue, 0);

    res.json({
      items,
      summary: {
        totalProducts: items.length,
        totalQuarantineUnits: items.reduce((s, i) => s + i.quarantineStock, 0),
        totalValue: Math.round(totalValue * 100) / 100,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/inventory/stock/quarantine/:id/release ────────────────────────
router.post("/stock/quarantine/:id/release", requireAuth, requirePermission("permits.supply"), async (req: AuthRequest, res, next) => {
  try {
    const { id } = req.params;
    const { quantity, reason } = req.body;

    if (!quantity || Number(quantity) <= 0) {
      res.status(400).json({ error: "A positive quantity is required" });
      return;
    }
    if (!reason || typeof reason !== "string" || reason.trim().length === 0) {
      res.status(400).json({ error: "A reason for release is required" });
      return;
    }

    const result = await prisma.$transaction(async (tx) => {
      return releaseQuarantine(
        tx,
        id,
        Number(quantity),
        req.user?.userId || "",
        req.user?.name || "",
        reason.trim()
      );
    });

    res.json({
      message: "تم إطلاق المنتج من الحجر بنجاح",
      result,
    });
  } catch (err: any) {
    if (err.message?.includes("not found")) {
      res.status(404).json({ error: err.message });
    } else if (err.message?.includes("Invalid quantity")) {
      res.status(400).json({ error: err.message });
    } else {
      next(err);
    }
  }
});

export default router;
