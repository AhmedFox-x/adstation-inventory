import { Router } from "express";
import { prisma } from "../config/database";
import { requireAuth, requirePermission, AuthRequest } from "../middleware/auth";

const router = Router();

function metaOf(req: AuthRequest) {
  return {
    userId: req.user?.userId || "",
    name: req.user?.name || req.user?.email || "",
    role: req.user?.role,
  };
}

async function generateTransferNumber(): Promise<string> {
  const now = new Date();
  const ym = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;
  const count = await prisma.transfer.count({
    where: { transferNumber: { startsWith: `TR-${ym}-` } },
  });
  return `TR-${ym}-${String(count + 1).padStart(5, "0")}`;
}

const VALID_TRANSITIONS: Record<string, string[]> = {
  draft: ["confirmed", "cancelled"],
  confirmed: ["in_transit", "cancelled"],
  in_transit: ["received", "cancelled"],
  received: [],
  cancelled: [],
};

function canTransition(from: string, to: string): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

// ── GET /transfers — list ──────────────────────────────────────────────────────
router.get("/transfers", requireAuth, requirePermission("transfers.view"), async (req, res) => {
  try {
    const { status, page = "1", limit = "20", search } = req.query as Record<string, string>;
    const where: any = { deletedAt: null };
    if (status && status !== "all") where.status = status;
    if (search) {
      where.OR = [
        { transferNumber: { contains: search, mode: "insensitive" } },
        { notes: { contains: search, mode: "insensitive" } },
      ];
    }

    const [transfers, total] = await Promise.all([
      prisma.transfer.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (Number(page) - 1) * Number(limit),
        take: Number(limit),
        include: {
          fromWarehouse: { select: { id: true, name: true, type: true } },
          toWarehouse: { select: { id: true, name: true, type: true } },
          items: {
            include: {
              product: { select: { id: true, name: true, sku: true, imageUrl: true } },
            },
          },
        },
      }),
      prisma.transfer.count({ where }),
    ]);

    res.json({
      transfers: transfers.map((tr) => ({
        ...tr,
        itemCount: tr.items.length,
        totalQuantity: tr.items.reduce((sum, i) => sum + i.quantity, 0),
      })),
      total,
      page: Number(page),
      pages: Math.ceil(total / Number(limit)),
    });
  } catch (err: any) {
    console.error("[Transfers List]", err?.message || err);
    if (!res.headersSent) res.status(500).json({ error: "Failed to list transfers" });
  }
});

// ── GET /transfers/:id — detail ────────────────────────────────────────────────
router.get("/transfers/:id", requireAuth, requirePermission("transfers.view"), async (req, res) => {
  try {
    const transfer = await prisma.transfer.findUnique({
      where: { id: req.params.id },
      include: {
        fromWarehouse: { select: { id: true, name: true, type: true } },
        toWarehouse: { select: { id: true, name: true, type: true } },
        items: {
          include: {
            product: { select: { id: true, name: true, sku: true, unit: true, imageUrl: true, stock: true, reservedStock: true, price: true } },
          },
        },
      },
    });
    if (!transfer || transfer.deletedAt) { res.status(404).json({ error: "Transfer not found" }); return; }

    const fromStock = await prisma.warehouseStock.aggregate({
      where: { warehouseId: transfer.fromWarehouseId },
      _sum: { quantity: true, reservedQuantity: true },
    });
    const toStock = await prisma.warehouseStock.aggregate({
      where: { warehouseId: transfer.toWarehouseId },
      _sum: { quantity: true, reservedQuantity: true },
    });

    res.json({
      transfer: {
        ...transfer,
        fromWarehouseStats: { totalQuantity: fromStock._sum.quantity || 0, totalReserved: fromStock._sum.reservedQuantity || 0 },
        toWarehouseStats: { totalQuantity: toStock._sum.quantity || 0, totalReserved: toStock._sum.reservedQuantity || 0 },
      },
    });
  } catch (err: any) {
    console.error("[Transfer Detail]", err?.message || err);
    if (!res.headersSent) res.status(500).json({ error: "Failed to get transfer" });
  }
});

// ── POST /transfers — create (draft) ──────────────────────────────────────────
router.post("/transfers", requireAuth, requirePermission("transfers.create"), async (req: AuthRequest, res) => {
  try {
    const { fromWarehouseId, toWarehouseId, items, notes } = req.body;
    if (!fromWarehouseId) { res.status(400).json({ error: "Source warehouse is required", field: "fromWarehouse" }); return; }
    if (!toWarehouseId) { res.status(400).json({ error: "Destination warehouse is required", field: "toWarehouse" }); return; }
    if (fromWarehouseId === toWarehouseId) { res.status(400).json({ error: "Source and destination must be different", field: "toWarehouse" }); return; }
    if (!items || !Array.isArray(items) || items.length === 0) {
      res.status(400).json({ error: "At least one item is required" }); return;
    }

    const [fromWh, toWh] = await Promise.all([
      prisma.warehouse.findUnique({ where: { id: fromWarehouseId } }),
      prisma.warehouse.findUnique({ where: { id: toWarehouseId } }),
    ]);
    if (!fromWh) { res.status(404).json({ error: "Source warehouse not found", field: "fromWarehouse" }); return; }
    if (!toWh) { res.status(404).json({ error: "Destination warehouse not found", field: "toWarehouse" }); return; }
    if (fromWh.deletedAt || !fromWh.isActive) { res.status(400).json({ error: `Cannot transfer from archived warehouse "${fromWh.name}"`, field: "fromWarehouse" }); return; }
    if (toWh.deletedAt || !toWh.isActive) { res.status(400).json({ error: `Cannot transfer to archived warehouse "${toWh.name}"`, field: "toWarehouse" }); return; }

    const productIds = items.map((it: any) => it.productId);
    const products = await prisma.product.findMany({ where: { id: { in: productIds }, deletedAt: null } });
    const productMap = new Map(products.map((p) => [p.id, p]));

    const validationErrors: string[] = [];
    for (const it of items) {
      const qty = Number(it.quantity);
      if (!it.productId) { validationErrors.push("A product is missing"); continue; }
      if (!qty || qty <= 0) { validationErrors.push(`Invalid quantity for item`); continue; }
      const product = productMap.get(it.productId);
      if (!product) { validationErrors.push(`Product not found: ${it.productId}`); continue; }

      const fromStock = await prisma.warehouseStock.findUnique({
        where: { warehouseId_productId: { warehouseId: fromWarehouseId, productId: it.productId } },
      });
      const available = (fromStock?.quantity || 0) - (fromStock?.reservedQuantity || 0);
      if (available < qty) {
        validationErrors.push(`${product.name}: only ${available} available in ${fromWh.name}, requested ${qty} (shortage: ${qty - available})`);
      }
    }
    if (validationErrors.length > 0) {
      res.status(400).json({ error: "Insufficient stock", details: validationErrors }); return;
    }

    const meta = metaOf(req);
    const transferNumber = await generateTransferNumber();

    const transfer = await prisma.$transaction(async (tx) => {
      return tx.transfer.create({
        data: {
          transferNumber,
          fromWarehouseId,
          toWarehouseId,
          status: "draft",
          notes: notes?.trim() || null,
          createdBy: meta.userId,
          createdByName: meta.name,
          items: {
            create: items.map((it: any) => ({
              productId: it.productId,
              quantity: Number(it.quantity),
            })),
          },
        },
        include: {
          fromWarehouse: { select: { id: true, name: true, type: true } },
          toWarehouse: { select: { id: true, name: true, type: true } },
          items: true,
        },
      });
    });

    res.status(201).json({ transfer });
  } catch (err: any) {
    console.error("[Transfer Create]", err?.message || err);
    if (!res.headersSent) res.status(500).json({ error: "Failed to create transfer" });
  }
});

// ── POST /transfers/:id/confirm — draft → confirmed ───────────────────────────
router.post("/transfers/:id/confirm", requireAuth, requirePermission("transfers.execute"), async (req: AuthRequest, res) => {
  try {
    const existing = await prisma.transfer.findUnique({
      where: { id: req.params.id },
      include: { items: true },
    });
    if (!existing) { res.status(404).json({ error: "Transfer not found" }); return; }
    if (!canTransition(existing.status, "confirmed")) {
      res.status(400).json({ error: `Cannot confirm transfer in "${existing.status}" status` }); return;
    }

    const meta = metaOf(req);
    const transfer = await prisma.transfer.update({
      where: { id: req.params.id },
      data: {
        status: "confirmed",
        confirmedBy: meta.userId,
        confirmedByName: meta.name,
        confirmedAt: new Date(),
      },
      include: {
        fromWarehouse: { select: { id: true, name: true, type: true } },
        toWarehouse: { select: { id: true, name: true, type: true } },
        items: true,
      },
    });
    res.json({ transfer });
  } catch (err: any) {
    console.error("[Transfer Confirm]", err?.message || err);
    if (!res.headersSent) res.status(500).json({ error: "Failed to confirm transfer" });
  }
});

// ── POST /transfers/:id/cancel — any non-terminal → cancelled ─────────────────
router.post("/transfers/:id/cancel", requireAuth, requirePermission("transfers.cancel"), async (req: AuthRequest, res) => {
  try {
    const existing = await prisma.transfer.findUnique({ where: { id: req.params.id } });
    if (!existing) { res.status(404).json({ error: "Transfer not found" }); return; }
    if (!canTransition(existing.status, "cancelled")) {
      res.status(400).json({ error: `Cannot cancel transfer in "${existing.status}" status` }); return;
    }

    const meta = metaOf(req);
    const transfer = await prisma.transfer.update({
      where: { id: req.params.id },
      data: {
        status: "cancelled",
        cancelledBy: meta.userId,
        cancelledByName: meta.name,
        cancelledAt: new Date(),
        cancelNote: req.body?.note?.trim() || null,
      },
      include: {
        fromWarehouse: { select: { id: true, name: true, type: true } },
        toWarehouse: { select: { id: true, name: true, type: true } },
        items: true,
      },
    });
    res.json({ transfer });
  } catch (err: any) {
    console.error("[Transfer Cancel]", err?.message || err);
    if (!res.headersSent) res.status(500).json({ error: "Failed to cancel transfer" });
  }
});

// ── POST /transfers/:id/execute — confirmed → in_transit (with row locks) ─────
router.post("/transfers/:id/execute", requireAuth, requirePermission("transfers.execute"), async (req: AuthRequest, res) => {
  try {
    const transfer = await prisma.transfer.findUnique({
      where: { id: req.params.id },
      include: {
        items: true,
        fromWarehouse: { select: { id: true, name: true } },
        toWarehouse: { select: { id: true, name: true } },
      },
    });
    if (!transfer) { res.status(404).json({ error: "Transfer not found" }); return; }
    if (!canTransition(transfer.status, "in_transit")) {
      res.status(400).json({ error: `Cannot execute transfer in "${transfer.status}" status` }); return;
    }

    const meta = metaOf(req);

    await prisma.$transaction(async (tx) => {
      // Pre-validate all items with row locks
      for (const item of transfer.items) {
        const fromStock = await tx.$queryRaw`
          SELECT ws."quantity", ws."reservedQuantity", p."name", p."sku"
          FROM "WarehouseStock" ws
          JOIN "Product" p ON p."id" = ws."productId"
          WHERE ws."warehouseId" = ${transfer.fromWarehouseId} AND ws."productId" = ${item.productId}
          FOR UPDATE
        ` as any[];

        const stock = fromStock[0];
        const physical = stock ? Number(stock.quantity) : 0;
        const reserved = stock ? Number(stock.reservedQuantity) : 0;
        const available = physical - reserved;
        const productName = stock?.name || item.productId;
        const sku = stock?.sku || null;

        if (available < item.quantity) {
          // Immediately throw to trigger full rollback — no partial commits
          throw new Error(JSON.stringify({
            type: "VALIDATION",
            errors: [{ productName, sku, available, requested: item.quantity, shortage: item.quantity - available }],
          }));
        }

        // Read destination stock BEFORE increment for correct log values
        const destStockBefore = await tx.warehouseStock.findUnique({
          where: { warehouseId_productId: { warehouseId: transfer.toWarehouseId, productId: item.productId } },
          select: { quantity: true },
        });
        const destOldQty = destStockBefore ? Number(destStockBefore.quantity) : 0;

        // Decrement source warehouse stock
        await tx.warehouseStock.update({
          where: { warehouseId_productId: { warehouseId: transfer.fromWarehouseId, productId: item.productId } },
          data: { quantity: { decrement: item.quantity } },
        });

        // Increment destination warehouse stock (upsert)
        await tx.warehouseStock.upsert({
          where: { warehouseId_productId: { warehouseId: transfer.toWarehouseId, productId: item.productId } },
          create: { warehouseId: transfer.toWarehouseId, productId: item.productId, quantity: item.quantity, reservedQuantity: 0 },
          update: { quantity: { increment: item.quantity } },
        });

        // Source inventory log
        await tx.inventoryLog.create({
          data: {
            type: "transfer_out",
            productId: item.productId,
            warehouseId: transfer.fromWarehouseId,
            oldStock: physical,
            newStock: physical - item.quantity,
            change: -item.quantity,
            notes: `Transfer ${transfer.transferNumber} — ${transfer.fromWarehouse.name} → ${transfer.toWarehouse.name}`,
            referenceType: "transfer",
            referenceId: transfer.id,
            userId: meta.userId,
            userName: meta.name,
            userRole: meta.role,
            entityType: "transfer",
            entityId: transfer.id,
            beforeData: { warehouse: transfer.fromWarehouse.name, stock: physical },
            afterData: { warehouse: transfer.fromWarehouse.name, stock: physical - item.quantity },
          },
        });

        // Destination inventory log
        await tx.inventoryLog.create({
          data: {
            type: "transfer_in",
            productId: item.productId,
            warehouseId: transfer.toWarehouseId,
            oldStock: destOldQty,
            newStock: destOldQty + item.quantity,
            change: item.quantity,
            notes: `Transfer ${transfer.transferNumber} — ${transfer.fromWarehouse.name} → ${transfer.toWarehouse.name}`,
            referenceType: "transfer",
            referenceId: transfer.id,
            userId: meta.userId,
            userName: meta.name,
            userRole: meta.role,
            entityType: "transfer",
            entityId: transfer.id,
            beforeData: { warehouse: transfer.toWarehouse.name, stock: destOldQty },
            afterData: { warehouse: transfer.toWarehouse.name, stock: destOldQty + item.quantity },
          },
        });
      }

      await tx.transfer.update({
        where: { id: transfer.id },
        data: {
          status: "in_transit",
          executedBy: meta.userId,
          executedByName: meta.name,
          executedAt: new Date(),
        },
      });
    });

    const updated = await prisma.transfer.findUnique({
      where: { id: transfer.id },
      include: {
        fromWarehouse: { select: { id: true, name: true, type: true } },
        toWarehouse: { select: { id: true, name: true, type: true } },
        items: true,
      },
    });

    res.json({ transfer: updated });
  } catch (err: any) {
    console.error("[Transfer Execute]", err?.message || err);
    if (err.message?.includes("VALIDATION")) {
      try {
        const parsed = JSON.parse(err.message);
        if (!res.headersSent) res.status(400).json({ error: "Insufficient stock", validationErrors: parsed.errors });
      } catch {
        if (!res.headersSent) res.status(400).json({ error: err.message });
      }
    } else {
      if (!res.headersSent) res.status(500).json({ error: "Failed to execute transfer" });
    }
  }
});

// ── POST /transfers/:id/receive — in_transit → received ───────────────────────
router.post("/transfers/:id/receive", requireAuth, requirePermission("transfers.execute"), async (req: AuthRequest, res) => {
  try {
    const existing = await prisma.transfer.findUnique({ where: { id: req.params.id } });
    if (!existing) { res.status(404).json({ error: "Transfer not found" }); return; }
    if (!canTransition(existing.status, "received")) {
      res.status(400).json({ error: `Cannot receive transfer in "${existing.status}" status` }); return;
    }

    const meta = metaOf(req);
    const transfer = await prisma.transfer.update({
      where: { id: req.params.id },
      data: { status: "received", receivedBy: meta.userId, receivedByName: meta.name, receivedAt: new Date() },
      include: {
        fromWarehouse: { select: { id: true, name: true, type: true } },
        toWarehouse: { select: { id: true, name: true, type: true } },
        items: true,
      },
    });
    res.json({ transfer });
  } catch (err: any) {
    console.error("[Transfer Receive]", err?.message || err);
    if (!res.headersSent) res.status(500).json({ error: "Failed to receive transfer" });
  }
});

export default router;
