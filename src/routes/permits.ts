import { Router } from "express";
import { prisma } from "../config/database";
import { AuthRequest, requireAuth, requirePermission } from "../middleware/auth";
import { createError } from "../middleware/errorHandler";
import { generateWithdrawalPermitNumber, generateSupplyPermitNumber } from "../utils/permitNumber";
import { checkAndSendAlerts } from "../utils/alerts";
import { applyPurchaseToProduct, calculateWithdrawalCost } from "../services/costService";
import { getDefaultWarehouseId, decrementWarehouseStock, incrementWarehouseStock } from "../utils/stockSync";

const router = Router();

// ── POST /api/inventory/withdraw ──────────────────────────────────────────────
router.post("/withdraw", requireAuth, requirePermission("permits.withdraw"), async (req: AuthRequest, res, next) => {
  try {
    const { clientName, clientId, salesName, notes, items, confirmed, operationType } = req.body;

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
      where: { id: { in: productIds }, deletedAt: null },
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
      const available = product.stock - (product.reservedStock ?? 0);
      if (requested > available) {
        shortages.push({
          productId: item.productId,
          productName: product.name,
          available: Math.max(0, available),
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
      const defaultWhId = await getDefaultWarehouseId(tx);
      const p = await tx.withdrawalPermit.create({
        data: {
          permitNumber,
          clientName: String(clientName).trim(),
          clientId: clientId || null,
          salesName: salesName || null,
          notes: notes || null,
          status: shortages.length > 0 ? "partial" : "completed",
          operationType: operationType || null,
        },
      });

      for (const item of items) {
        const product = productMap.get(item.productId);
        if (!product) continue;

        const requested = Number(item.quantityRequested);
        const prodAvailable = product.stock - (product.reservedStock ?? 0);
        const actual = Math.min(requested, Math.max(0, prodAvailable));
        if (actual <= 0) continue;

        // Atomic read inside transaction for accurate before/after
        const current = await tx.product.findUnique({
          where: { id: item.productId },
          select: { stock: true },
        });
        if (!current) continue;

        const before = current.stock;
        const after = before - actual;

        // Atomic decrement — no race condition
        await tx.product.update({
          where: { id: item.productId },
          data: { stock: { decrement: actual } },
        });

        // Sync WarehouseStock
        await decrementWarehouseStock(tx, defaultWhId, item.productId, actual);

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

        // Calculate withdrawal cost (does NOT change average cost)
        const withdrawalCost = await calculateWithdrawalCost(tx, item.productId, actual);

        // Create per-product inventory log with real stock values and cost
        await tx.inventoryLog.create({
          data: {
            type: "withdraw",
            productId: item.productId,
            oldStock: before,
            newStock: after,
            change: -actual,
            clientName: String(clientName).trim(),
            salesName: salesName || null,
            notes: notes || null,
            referenceType: "withdrawal",
            referenceId: p.id,
            userId: req.user?.userId,
            userName: req.user?.name,
            userRole: req.user?.role,
            entityType: "permit",
            entityId: p.id,
            beforeData: {
              stock: before,
              costPrice: withdrawalCost.unitCost,
            },
            afterData: {
              stock: after,
              costPrice: withdrawalCost.unitCost,
              withdrawalTotalCost: withdrawalCost.totalCost,
            },
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

    // Fire-and-forget: check for low stock alerts (non-blocking)
    const affectedProductIds = items.filter((it: any) => it.actual > 0).map((it: any) => it.productId);
    if (affectedProductIds.length > 0) {
      prisma.product.findMany({
        where: { id: { in: affectedProductIds }, deletedAt: null },
        select: { id: true, name: true, stock: true, minStock: true, category: true },
      }).then(checkAndSendAlerts).catch(() => {});
    }
  } catch (err) {
    next(err);
  }
});

// ── POST /api/inventory/supply ────────────────────────────────────────────────
router.post("/supply", requireAuth, requirePermission("permits.supply"), async (req: AuthRequest, res, next) => {
  try {
    const { supplierName, notes, items, newProducts } = req.body;

    if ((!items || items.length === 0) && (!newProducts || newProducts.length === 0)) {
      res.status(400).json({ error: "At least one item or new product is required" });
      return;
    }

    const permitNumber = await generateSupplyPermitNumber();
    const permit = await prisma.$transaction(async (tx) => {
      const defaultWhId = await getDefaultWarehouseId(tx);
      const p = await tx.supplyPermit.create({
        data: {
          permitNumber,
          supplierName: supplierName || null,
          notes: notes || null,
        },
      });

      // Supply existing products
      if (items && items.length > 0) {
        const productIds = items.map((it: any) => it.productId);
        const products = await tx.product.findMany({
          where: { id: { in: productIds }, deletedAt: null },
        });
        const productMap = new Map(products.map((pr) => [pr.id, pr]));

        for (const item of items) {
          const product = productMap.get(item.productId);
          if (!product) continue;

          const qty = Number(item.quantity);
          if (qty <= 0) continue;

          // Atomic read inside transaction for accurate before/after
          const current = await tx.product.findUnique({
            where: { id: item.productId },
            select: { stock: true, costPrice: true },
          });
          if (!current) continue;

          const before = current.stock;
          const after = before + qty;

          // Atomic increment — no race condition
          await tx.product.update({
            where: { id: item.productId },
            data: { stock: { increment: qty } },
          });

          // Sync WarehouseStock
          await incrementWarehouseStock(tx, defaultWhId, item.productId, qty);

          await tx.supplyItem.create({
            data: {
              permitId: p.id,
              productId: item.productId,
              quantity: qty,
              unitPrice: Number(item.unitPrice) || 0,
            },
          });

          // Update Moving Average Cost if unitPrice provided
          const itemUnitPrice = Number(item.unitPrice) || 0;
          if (itemUnitPrice > 0) {
            await applyPurchaseToProduct(tx, item.productId, qty, itemUnitPrice);
          }

          const updatedProduct = await tx.product.findUnique({ where: { id: item.productId }, select: { costPrice: true } });
          await tx.inventoryLog.create({
            data: {
              type: "supply",
              productId: item.productId,
              oldStock: before,
              newStock: after,
              change: qty,
              salesName: supplierName || null,
              notes: notes || null,
              referenceType: "supply",
              referenceId: p.id,
              userId: req.user?.userId,
              userName: req.user?.name,
              userRole: req.user?.role,
              entityType: "permit",
              entityId: p.id,
              beforeData: { stock: before, costPrice: current.costPrice ?? null },
              afterData: { stock: after, costPrice: updatedProduct?.costPrice ?? null },
            },
          });
        }
      }

      // Create new products
      if (newProducts && newProducts.length > 0) {
        for (const np of newProducts) {
          if (!np.name || !String(np.name).trim()) continue;

          const qty = Number(np.stock) || 0;
          const unitPrice = Number(np.unitPrice) || 0;

          const product = await tx.product.create({
            data: {
              name: String(np.name).trim(),
              variant: np.variant || null,
              stock: qty,
            },
          });

          await tx.supplyItem.create({
            data: {
              permitId: p.id,
              productId: product.id,
              quantity: qty,
              unitPrice: unitPrice,
            },
          });

          // Apply cost if unitPrice provided
          if (unitPrice > 0 && qty > 0) {
            await applyPurchaseToProduct(tx, product.id, qty, unitPrice);
          }

          await tx.inventoryLog.create({
            data: {
              type: "supply",
              productId: product.id,
              oldStock: 0,
              newStock: qty,
              change: qty,
              salesName: supplierName || null,
              notes: notes || null,
              referenceType: "supply",
              referenceId: p.id,
              userId: req.user?.userId,
              userName: req.user?.name,
              userRole: req.user?.role,
              entityType: "permit",
              entityId: p.id,
              beforeData: { stock: 0, costPrice: null },
              afterData: { stock: qty, costPrice: unitPrice > 0 ? unitPrice : null },
            },
          });
        }
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
