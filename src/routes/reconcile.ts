import { Router } from "express";
import { prisma } from "../config/database";
import { requireAuth, requirePermission, assertPermission, AuthRequest } from "../middleware/auth";

const router = Router();

// ── POST /api/inventory/inventory/reconcile ──────────────────────────────────
// Compares Product.stock with the sum of WarehouseStock.quantity for each product.
// Returns a report of mismatches without changing any data (dry run by default).
// With ?fix=true, it fixes Product.stock to match the sum of WarehouseStock.
router.post("/inventory/reconcile", requireAuth, requirePermission("products.view"), async (req: AuthRequest, res, next) => {
  try {
    const { fix } = req.query as Record<string, string>;

    // Destructive stock-fixing requires a dedicated sensitive permission (see AGENTS.md 2.2).
    // "products.view" only grants the read-only reconciliation REPORT, never mutation.
    // assertPermission THROWS on denial → the outer catch forwards a single 403 to the
    // client and the mutation block below never runs (unlike a silent res.send() + continue).
    if (fix === "true") {
      await assertPermission(req, "stock.adjust");
    }

    // Get all active (non-archived) products
    const products = await prisma.product.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true, stock: true, sku: true },
    });

    // Get total WarehouseStock per product
    const warehouseAggregates = await prisma.warehouseStock.groupBy({
      by: ["productId"],
      _sum: { quantity: true },
    });

    const warehouseMap = new Map<string, number>();
    for (const agg of warehouseAggregates) {
      warehouseMap.set(agg.productId, Number(agg._sum.quantity ?? 0));
    }

    const mismatches: Array<{
      productId: string;
      name: string;
      sku: string | null;
      productStock: number;
      warehouseStockTotal: number;
      drift: number;
    }> = [];

    for (const product of products) {
      const whTotal = warehouseMap.get(product.id) ?? 0;
      const drift = product.stock - whTotal;
      if (drift !== 0) {
        mismatches.push({
          productId: product.id,
          name: product.name,
          sku: product.sku,
          productStock: product.stock,
          warehouseStockTotal: whTotal,
          drift,
        });
      }
    }

    let fixed = 0;
    if (fix === "true" && mismatches.length > 0) {
      // Fix each product by setting Product.stock to the sum of WarehouseStock
      await prisma.$transaction(async (tx) => {
        for (const m of mismatches) {
          await tx.product.update({
            where: { id: m.productId },
            data: { stock: m.warehouseStockTotal },
          });

          await tx.inventoryLog.create({
            data: {
              type: "reconciliation",
              productId: m.productId,
              oldStock: m.productStock,
              newStock: m.warehouseStockTotal,
              change: m.warehouseStockTotal - m.productStock,
              notes: `Reconciliation: Product.stock corrected from ${m.productStock} to ${m.warehouseStockTotal} (drift was ${m.drift})`,
              userId: req.user?.userId,
              userName: req.user?.name,
              userRole: req.user?.role,
              entityType: "product",
              entityId: m.productId,
              beforeData: { stock: m.productStock },
              afterData: { stock: m.warehouseStockTotal },
            },
          });
        }
        fixed = mismatches.length;
      });
    }

    res.json({
      totalProducts: products.length,
      mismatchCount: mismatches.length,
      fixed,
      mismatches: mismatches.slice(0, 100), // Cap at 100 for response size
    });
  } catch (err) {
    next(err);
  }
});

export default router;
