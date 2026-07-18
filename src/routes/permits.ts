import { Router } from "express";
import { prisma } from "../config/database";
import { AuthRequest, requireAuth } from "../middleware/auth";
import { createError } from "../middleware/errorHandler";
import { generateWithdrawalPermitNumber, generateSupplyPermitNumber } from "../utils/permitNumber";

const router = Router();

// ── POST /api/inventory/withdraw ──────────────────────────────────────────────
router.post("/withdraw", requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const { clientName, salesName, notes, items, confirmed, operationType } = req.body;

    if (!clientName || !String(clientName).trim()) {
      res.status(400).json({ error: "Client name is required" });
      return;
    }
    if (!items || !Array.isArray(items) || items.length === 0) {
      res.status(400).json({ error: "At least one item is required" });
      return;
    }

    // Validate all items exist and have IDs
    const productIds = items.map((it: any) => it.productId);
    const products = await prisma.product.findMany({
      where: { id: { in: productIds } },
    });
    const productMap = new Map(products.map((p) => [p.id, p]));

    // Check availability
    const shortages: Array<{
      productId: string;
      productName: string;
      available: number;
      requested: number;
    }> = [];

    for (const item of items) {
      const product = productMap.get(item.productId);
      if (!product) {
        shortages.push({
          productId: item.productId,
          productName: "Unknown",
          available: 0,
          requested: Number(item.quantityRequested),
        });
        continue;
      }
      const requested = Number(item.quantityRequested);
      if (requested > product.stock) {
        shortages.push({
          productId: item.productId,
          productName: product.name,
          available: product.stock,
          requested,
        });
      }
    }

    if (shortages.length > 0 && !confirmed) {
      res.json({ status: "partial", shortages });
      return;
    }

    // Execute withdrawal in transaction
    const permitNumber = await generateWithdrawalPermitNumber();
    const permit = await prisma.$transaction(async (tx) => {
      const p = await tx.withdrawalPermit.create({
        data: {
          permitNumber,
          clientName: String(clientName).trim(),
          salesName: salesName || null,
          notes: notes || null,
          status: shortages.length > 0 ? "partial" : "completed",
          operationType: operationType || null,
        },
      });

      let totalChange = 0;
      let firstProductId = "";

      for (const item of items) {
        const product = productMap.get(item.productId);
        if (!product) continue;

        const requested = Number(item.quantityRequested);
        const actual = Math.min(requested, product.stock);
        if (actual <= 0) continue;

        totalChange -= actual;
        if (!firstProductId) firstProductId = item.productId;

        const before = product.stock;
        const after = before - actual;

        // Update stock
        await tx.product.update({
          where: { id: item.productId },
          data: { stock: after },
        });

        // Create permit item
        await tx.withdrawalItem.create({
          data: {
            permitId: p.id,
            productId: item.productId,
            quantityRequested: requested,
            quantityActual: actual,
            matchConfidence: item.matchConfidence || null,
          },
        });
      }

      if (firstProductId) {
        await tx.inventoryLog.create({
          data: {
            type: "withdraw",
            productId: firstProductId,
            oldStock: 0,
            newStock: 0,
            change: totalChange,
            clientName: String(clientName).trim(),
            salesName: salesName || null,
            notes: notes || null,
            referenceType: "withdrawal",
            referenceId: p.id,
          },
        });
      }

      return p;
    });

    res.status(201).json({
      status: shortages.length > 0 ? "partial" : "completed",
      permit: {
        id: permit.id,
        permitNumber: permit.permitNumber,
        clientName: permit.clientName,
        salesName: permit.salesName,
        status: permit.status,
        createdAt: permit.createdAt,
        operationType: permit.operationType,
      },
      shortages: shortages.length > 0 ? shortages : undefined,
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/inventory/supply ────────────────────────────────────────────────
router.post("/supply", requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const { supplierName, notes, items, newProducts } = req.body;

    if ((!items || items.length === 0) && (!newProducts || newProducts.length === 0)) {
      res.status(400).json({ error: "At least one item or new product is required" });
      return;
    }

    const permitNumber = await generateSupplyPermitNumber();
    const permit = await prisma.$transaction(async (tx) => {
      const p = await tx.supplyPermit.create({
        data: {
          permitNumber,
          supplierName: supplierName || null,
          notes: notes || null,
        },
      });

      let totalChange = 0;
      let firstProductId = "";

      // Supply existing products
      if (items && items.length > 0) {
        const productIds = items.map((it: any) => it.productId);
        const products = await tx.product.findMany({
          where: { id: { in: productIds } },
        });
        const productMap = new Map(products.map((pr) => [pr.id, pr]));

        for (const item of items) {
          const product = productMap.get(item.productId);
          if (!product) continue;

          const qty = Number(item.quantity);
          if (qty <= 0) continue;

          totalChange += qty;
          if (!firstProductId) firstProductId = item.productId;

          const before = product.stock;
          const after = before + qty;

          await tx.product.update({
            where: { id: item.productId },
            data: { stock: after },
          });

          await tx.supplyItem.create({
            data: {
              permitId: p.id,
              productId: item.productId,
              quantity: qty,
            },
          });
        }
      }

      // Create new products
      if (newProducts && newProducts.length > 0) {
        for (const np of newProducts) {
          if (!np.name || !String(np.name).trim()) continue;

          const product = await tx.product.create({
            data: {
              name: String(np.name).trim(),
              variant: np.variant || null,
              stock: Number(np.stock) || 0,
            },
          });

          totalChange += Number(np.stock) || 0;
          if (!firstProductId) firstProductId = product.id;

          await tx.supplyItem.create({
            data: {
              permitId: p.id,
              productId: product.id,
              quantity: Number(np.stock) || 0,
            },
          });
        }
      }

      if (firstProductId) {
        await tx.inventoryLog.create({
          data: {
            type: "supply",
            productId: firstProductId,
            oldStock: 0,
            newStock: 0,
            change: totalChange,
            salesName: supplierName || null,
            notes: notes || null,
            referenceType: "supply",
            referenceId: p.id,
          },
        });
      }

      return p;
    });

    res.status(201).json({
      permit: {
        id: permit.id,
        permitNumber: permit.permitNumber,
        supplierName: permit.supplierName,
        createdAt: permit.createdAt,
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
