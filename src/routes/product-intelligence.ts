/**
 * product-intelligence.ts — Product Intelligence + Reorder Engine API
 *
 * GET  /api/inventory/intelligence/products    — full intelligence for all products
 * GET  /api/inventory/intelligence/reorder     — reorder suggestions
 * POST /api/inventory/intelligence/reorder/generate — auto-generate PO drafts
 */

import { Router } from "express";
import { prisma } from "../config/database";
import { requireAuth, requirePermission, AuthRequest } from "../middleware/auth";
import { getProductIntelligence, getReorderSuggestions, generateReorderPODraft } from "../services/productIntelligence";

const router = Router();

// ── GET /api/inventory/intelligence/products ─────────────────────────────────
router.get("/intelligence/products", requireAuth, requirePermission("products.view"), async (req: AuthRequest, res, next) => {
  try {
    const { category, abcClass, needsReorder, search } = req.query as Record<string, string>;

    const intelligence = await getProductIntelligence(prisma, {
      category: category || undefined,
      abcClass: abcClass || undefined,
      needsReorder: needsReorder === "true",
      search: search || undefined,
    });

    // Summary stats
    const totalProducts = intelligence.length;
    const criticalCount = intelligence.filter((i) => i.urgency === "critical").length;
    const warningCount = intelligence.filter((i) => i.urgency === "warning").length;
    const reorderCount = intelligence.filter((i) => i.needsReorder).length;
    const totalInventoryValue = intelligence.reduce((s, i) => s + i.currentStock * (i.costPrice || 0), 0);
    const abcA = intelligence.filter((i) => i.abcClass === "A").length;
    const abcB = intelligence.filter((i) => i.abcClass === "B").length;
    const abcC = intelligence.filter((i) => i.abcClass === "C").length;

    res.json({
      products: intelligence,
      summary: {
        totalProducts,
        criticalCount,
        warningCount,
        reorderCount,
        totalInventoryValue: Math.round(totalInventoryValue * 100) / 100,
        abc: { A: abcA, B: abcB, C: abcC },
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/inventory/intelligence/reorder ──────────────────────────────────
router.get("/intelligence/reorder", requireAuth, requirePermission("purchase_orders.view"), async (req: AuthRequest, res, next) => {
  try {
    const suggestions = await getReorderSuggestions(prisma, { includeNonCritical: true });

    const totalEstimatedCost = suggestions.reduce((s, r) => s + r.estimatedCost, 0);
    const criticalCount = suggestions.filter((s) => s.urgency === "critical").length;
    const warningCount = suggestions.filter((s) => s.urgency === "warning").length;

    res.json({
      suggestions,
      summary: {
        totalItems: suggestions.length,
        criticalCount,
        warningCount,
        totalEstimatedCost: Math.round(totalEstimatedCost * 100) / 100,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/inventory/intelligence/reorder/generate ───────────────────────
router.post("/intelligence/reorder/generate", requireAuth, requirePermission("purchase_orders.create"), async (req: AuthRequest, res, next) => {
  try {
    const suggestions = await getReorderSuggestions(prisma);

    const poId = await prisma.$transaction(async (tx) => {
      return generateReorderPODraft(tx, suggestions, req.user?.userId || "", req.user?.name || "");
    });

    if (!poId) {
      res.status(400).json({ error: "No reorder suggestions with assigned suppliers to generate PO from" });
      return;
    }

    res.json({
      message: "تم إنشاء طلب شراء تلقائي بنجاح",
      purchaseOrderId: poId,
      itemCount: suggestions.length,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
