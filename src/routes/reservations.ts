import { Router } from "express";
import { prisma } from "../config/database";
import { AuthRequest, requireAuth, requirePermission } from "../middleware/auth";
import { getDefaultWarehouseId, incrementReservedStock, decrementReservedStock, decrementWarehouseStock } from "../utils/stockSync";

const router = Router();

// GET /reservations — قائمة الحجوزات مع فلترة
router.get("/reservations", requireAuth, requirePermission("reservations.view"), async (req: AuthRequest, res, next) => {
  try {
    const { search, status, page = "1", limit = "50" } = req.query as Record<string, string>;
    const where: any = { deletedAt: null };

    if (status && status !== "all") {
      where.status = status;
    }
    if (search) {
      where.OR = [
        { product: { name: { contains: search, mode: "insensitive" } } },
        { client: { name: { contains: search, mode: "insensitive" } } },
      ];
    }

    const skip = (Number(page) - 1) * Number(limit);
    const take = Number(limit);

    const [reservations, total] = await Promise.all([
      prisma.reservation.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take,
        include: {
          product: { select: { id: true, name: true, variant: true, stock: true, reservedStock: true } },
          client: { select: { id: true, name: true } },
        },
      }),
      prisma.reservation.count({ where }),
    ]);

    res.json({
      reservations,
      page: Number(page),
      limit: take,
      total,
      pages: Math.ceil(total / take),
    });
  } catch (err) {
    next(err);
  }
});

// GET /reservations/:id — تفاصيل حجز واحد
router.get("/reservations/:id", requireAuth, requirePermission("reservations.view"), async (req, res, next) => {
  try {
    const reservation = await prisma.reservation.findUnique({
      where: { id: req.params.id },
      include: {
        product: { select: { id: true, name: true, variant: true, stock: true, reservedStock: true } },
        client: { select: { id: true, name: true } },
      },
    });
    if (!reservation || reservation.deletedAt) {
      res.status(404).json({ error: "Reservation not found" });
      return;
    }
    res.json({ reservation });
  } catch (err) {
    next(err);
  }
});

// POST /reservations — إنشاء حجز جديد
router.post("/reservations", requireAuth, requirePermission("reservations.create"), async (req: AuthRequest, res, next) => {
  try {
    const { productId, clientId, warehouseId, quantity, notes, expiresAt } = req.body;

    if (!productId || !quantity || quantity <= 0) {
      res.status(400).json({ error: "Product ID and positive quantity are required" });
      return;
    }

    const product = await prisma.product.findFirst({ where: { id: productId, deletedAt: null } });
    if (!product) {
      res.status(404).json({ error: "Product not found" });
      return;
    }

    const available = product.stock - product.reservedStock;
    if (quantity > available) {
      res.status(400).json({
        error: "Insufficient available stock",
        available: Math.max(0, available),
        requested: quantity,
      });
      return;
    }

    const reservation = await prisma.$transaction(async (tx) => {
      let resolvedWarehouseId = warehouseId;
      if (!resolvedWarehouseId) {
        const defaultWh = await tx.warehouse.findFirst({ where: { isActive: true }, orderBy: { createdAt: "asc" } });
        resolvedWarehouseId = defaultWh?.id;
      }
      if (!resolvedWarehouseId) throw new Error("No active warehouse found. Provide a valid warehouseId.");
      const r = await tx.reservation.create({
        data: {
          productId,
          clientId: clientId || null,
          warehouseId: resolvedWarehouseId,
          quantity,
          notes: notes || null,
          expiresAt: expiresAt ? new Date(expiresAt) : null,
          createdBy: req.user?.userId || "",
        },
        include: {
          product: { select: { id: true, name: true, variant: true, stock: true, reservedStock: true } },
          client: { select: { id: true, name: true } },
        },
      });

      await tx.product.update({
        where: { id: productId },
        data: { reservedStock: { increment: quantity } },
      });

      // Sync WarehouseStock reservedQuantity
      await incrementReservedStock(tx, resolvedWarehouseId, productId, quantity);

      return r;
    });

    res.status(201).json({ reservation });
  } catch (err) {
    next(err);
  }
});

// PATCH /reservations/:id/cancel — إلغاء حجز
router.patch("/reservations/:id/cancel", requireAuth, requirePermission("reservations.cancel"), async (req: AuthRequest, res, next) => {
  try {
    const existing = await prisma.reservation.findUnique({
      where: { id: req.params.id },
    });
    if (!existing) {
      res.status(404).json({ error: "Reservation not found" });
      return;
    }
    if (existing.status !== "active") {
      res.status(400).json({ error: "Only active reservations can be cancelled" });
      return;
    }

    const reservation = await prisma.$transaction(async (tx) => {
      const r = await tx.reservation.update({
        where: { id: req.params.id },
        data: { status: "cancelled" },
        include: {
          product: { select: { id: true, name: true, variant: true, stock: true, reservedStock: true } },
          client: { select: { id: true, name: true } },
        },
      });

      await tx.product.update({
        where: { id: existing.productId },
        data: { reservedStock: { decrement: existing.quantity } },
      });

      // Sync WarehouseStock reservedQuantity
      await decrementReservedStock(tx, existing.warehouseId, existing.productId, existing.quantity);

      return r;
    });

    res.json({ reservation });
  } catch (err) {
    next(err);
  }
});

// PATCH /reservations/:id/fulfill — تنفيذ حجز (خصم من المخزون)
router.patch("/reservations/:id/fulfill", requireAuth, requirePermission("reservations.fulfill"), async (req: AuthRequest, res, next) => {
  try {
    const existing = await prisma.reservation.findUnique({
      where: { id: req.params.id },
      include: { product: true },
    });
    if (!existing) {
      res.status(404).json({ error: "Reservation not found" });
      return;
    }
    if (existing.status !== "active") {
      res.status(400).json({ error: "Only active reservations can be fulfilled" });
      return;
    }
    if (existing.quantity > existing.product.stock) {
      res.status(400).json({
        error: "Insufficient stock to fulfill reservation",
        stock: existing.product.stock,
        required: existing.quantity,
      });
      return;
    }

    const reservation = await prisma.$transaction(async (tx) => {
      const current = await tx.product.findUnique({
        where: { id: existing.productId },
        select: { stock: true },
      });
      if (!current) throw new Error("Product not found");

      const before = current.stock;
      const after = before - existing.quantity;

      const r = await tx.reservation.update({
        where: { id: req.params.id },
        data: { status: "fulfilled" },
        include: {
          product: { select: { id: true, name: true, variant: true, stock: true, reservedStock: true } },
          client: { select: { id: true, name: true } },
        },
      });

      await tx.product.update({
        where: { id: existing.productId },
        data: {
          stock: { decrement: existing.quantity },
          reservedStock: { decrement: existing.quantity },
        },
      });

      // Sync WarehouseStock
      await decrementWarehouseStock(tx, existing.warehouseId, existing.productId, existing.quantity);
      await decrementReservedStock(tx, existing.warehouseId, existing.productId, existing.quantity);

      await tx.inventoryLog.create({
        data: {
          type: "reservation_fulfill",
          productId: existing.productId,
          oldStock: before,
          newStock: after,
          change: -existing.quantity,
          notes: `تنفيذ الحجز: ${existing.id}`,
          referenceType: "reservation",
          referenceId: existing.id,
          userId: req.user?.userId,
          userName: req.user?.name,
          userRole: req.user?.role,
          entityType: "reservation",
          entityId: existing.id,
          beforeData: { stock: before, reservedStock: existing.quantity },
          afterData: { stock: after, reservedStock: 0 },
        },
      });

      return r;
    });

    res.json({ reservation });
  } catch (err) {
    next(err);
  }
});

export default router;
