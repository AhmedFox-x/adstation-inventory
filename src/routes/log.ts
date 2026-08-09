import { Router } from "express";
import { prisma } from "../config/database";
import { requireAuth, requirePermission } from "../middleware/auth";

const router = Router();

// ── GET /api/inventory/log ────────────────────────────────────────────────────
router.get("/log", requireAuth, requirePermission("logs.view"), async (req, res, next) => {
  try {
    const { date, type, search, page = "1", limit = "20" } = req.query as Record<string, string>;
    const where: any = {};

    if (date) {
      const dayStart = new Date(date);
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(date);
      dayEnd.setHours(23, 59, 59, 999);
      where.createdAt = { gte: dayStart, lte: dayEnd };
    }

    if (type && type !== "all") {
      where.type = type;
    }

    if (search) {
      // Search by product name
      const productWhere = { name: { contains: search } };

      // Also search by permit number — find matching permit IDs
      const [matchingWithdrawals, matchingSupplies] = await Promise.all([
        prisma.withdrawalPermit.findMany({
          where: {
            OR: [
              { permitNumber: { contains: search } },
              { permitNumberOrig: { contains: search } },
            ],
          },
          select: { id: true },
        }),
        prisma.supplyPermit.findMany({
          where: {
            OR: [
              { permitNumber: { contains: search } },
              { permitNumberOrig: { contains: search } },
            ],
          },
          select: { id: true },
        }),
      ]);

      const permitIds = [
        ...matchingWithdrawals.map(p => p.id),
        ...matchingSupplies.map(p => p.id),
      ];

      // Combine: product name match OR permit ID match
      where.OR = [
        { product: productWhere },
        ...(permitIds.length > 0 ? [
          { referenceType: "withdrawal", referenceId: { in: permitIds } },
          { referenceType: "supply", referenceId: { in: permitIds } },
        ] : []),
      ];
    }

    const skip = (Number(page) - 1) * Number(limit);
    const take = Number(limit);

    const [logs, total] = await Promise.all([
      prisma.inventoryLog.findMany({
        where,
        include: { product: { select: { name: true } } },
        orderBy: { createdAt: "desc" },
        skip,
        take,
      }),
      prisma.inventoryLog.count({ where }),
    ]);

    // Fetch permit numbers for each log
    const logsWithPermit = await Promise.all(
      logs.map(async (l) => {
        let permitNumber: string | null = null;
        let permitNumberOrig: string | null = null;
        if (l.referenceType === "withdrawal" && l.referenceId) {
          const w = await prisma.withdrawalPermit.findUnique({
            where: { id: l.referenceId },
            select: { permitNumber: true, permitNumberOrig: true },
          });
          permitNumber = w?.permitNumber || null;
          permitNumberOrig = w?.permitNumberOrig || null;
        } else if (l.referenceType === "supply" && l.referenceId) {
          const s = await prisma.supplyPermit.findUnique({
            where: { id: l.referenceId },
            select: { permitNumber: true, permitNumberOrig: true },
          });
          permitNumber = s?.permitNumber || null;
          permitNumberOrig = s?.permitNumberOrig || null;
        }
        return {
          id: l.id,
          type: l.type,
          permitNumber: permitNumberOrig || permitNumber,
          oldStock: l.oldStock,
          newStock: l.newStock,
          change: l.change,
          notes: l.notes === "via scan" ? null : l.notes,
          referenceType: l.referenceType,
          referenceId: l.referenceId,
          createdAt: l.createdAt,
        };
      })
    );

    res.json({
      logs: logsWithPermit,
      pagination: {
        page: Number(page),
        limit: take,
        total,
        pages: Math.ceil(total / take),
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/inventory/log/:id — Full detail with permit + image ─────────────
router.get("/log/:id", requireAuth, requirePermission("logs.view"), async (req, res, next) => {
  try {
    const { id } = req.params;

    const log = await prisma.inventoryLog.findUnique({
      where: { id },
      include: { product: { select: { name: true, variant: true, sku: true } } },
    });

    if (!log) {
      res.status(404).json({ error: "Log entry not found" });
      return;
    }

    let permit: any = null;
    let items: any[] = [];

    if (log.referenceType === "withdrawal" && log.referenceId) {
      const w = await prisma.withdrawalPermit.findUnique({
        where: { id: log.referenceId },
        include: {
          items: {
            include: { product: { select: { name: true, variant: true } } },
          },
        },
      });
      if (w) {
        permit = {
          id: w.id,
          permitNumber: w.permitNumber,
          clientName: w.clientName,
          salesName: w.salesName,
          notes: w.notes,
          status: w.status,
          imageBase64: w.imageBase64,
          imageMimeType: w.imageMimeType,
          orderDate: w.orderDate,
          deliveryDate: w.deliveryDate,
          permitNumberOrig: w.permitNumberOrig,
          operationType: w.operationType,
          createdAt: w.createdAt,
        };
        items = w.items.map((it) => ({
          id: it.id,
          productId: it.productId,
          productName: it.product.name,
          productVariant: it.product.variant,
          quantityRequested: it.quantityRequested,
          quantityActual: it.quantityActual,
        }));
      }
    } else if (log.referenceType === "supply" && log.referenceId) {
      const s = await prisma.supplyPermit.findUnique({
        where: { id: log.referenceId },
        include: {
          items: {
            include: { product: { select: { name: true, variant: true } } },
          },
        },
      });
      if (s) {
        permit = {
          id: s.id,
          permitNumber: s.permitNumber,
          supplierName: s.supplierName,
          salesName: s.salesName,
          clientName: s.clientName,
          notes: s.notes,
          imageBase64: s.imageBase64,
          imageMimeType: s.imageMimeType,
          orderDate: s.orderDate,
          deliveryDate: s.deliveryDate,
          permitNumberOrig: s.permitNumberOrig,
          createdAt: s.createdAt,
        };
        items = s.items.map((it) => ({
          id: it.id,
          productId: it.productId,
          productName: it.product.name,
          productVariant: it.product.variant,
          quantity: it.quantity,
        }));
      }
    }

    res.json({
      id: log.id,
      type: log.type,
      productId: log.productId,
      productName: log.product.name,
      productVariant: log.product.variant,
      productSku: log.product.sku,
      oldStock: log.oldStock,
      newStock: log.newStock,
      change: log.change,
      clientName: log.clientName,
      salesName: log.salesName,
      notes: log.notes,
      referenceType: log.referenceType,
      referenceId: log.referenceId,
      createdAt: log.createdAt,
      permit,
      items,
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/inventory/report ─────────────────────────────────────────────────
router.get("/report", requireAuth, requirePermission("reports.view"), async (req, res, next) => {
  try {
    const { date, from, to } = req.query as Record<string, string>;

    let dayStart: Date, dayEnd: Date;
    if (from && to) {
      dayStart = new Date(from);
      dayStart.setHours(0, 0, 0, 0);
      dayEnd = new Date(to);
      dayEnd.setHours(23, 59, 59, 999);
    } else {
      const targetDate = date || new Date().toISOString().slice(0, 10);
      dayStart = new Date(targetDate);
      dayStart.setHours(0, 0, 0, 0);
      dayEnd = new Date(targetDate);
      dayEnd.setHours(23, 59, 59, 999);
    }

    const logs = await prisma.inventoryLog.findMany({
      where: {
        createdAt: { gte: dayStart, lte: dayEnd },
      },
      include: { product: { select: { name: true, stock: true } } },
      orderBy: { createdAt: "asc" },
    });

    let totalUp = 0;
    let totalDown = 0;
    const clientsSet = new Set<string>();

    const byProductMap: Record<string, {
      name: string; before: number; after: number; delta: number;
      moves: number; supplyTotal: number; withdrawTotal: number; currentStock: number;
    }> = {};

    for (const log of logs) {
      if (log.change > 0) totalUp += log.change;
      else totalDown += Math.abs(log.change);

      if (log.clientName) clientsSet.add(log.clientName);

      if (!byProductMap[log.productId]) {
        byProductMap[log.productId] = {
          name: log.product.name,
          before: 0,
          after: 0,
          delta: 0,
          moves: 0,
          supplyTotal: 0,
          withdrawTotal: 0,
          currentStock: log.product.stock,
        };
      }
      const p = byProductMap[log.productId];
      p.delta += log.change;
      p.moves += 1;
      if (log.type === "supply") p.supplyTotal += Math.abs(log.change);
      else if (log.type === "withdraw") p.withdrawTotal += Math.abs(log.change);
    }

    for (const [productId, p] of Object.entries(byProductMap)) {
      p.after = p.currentStock;
      p.before = p.currentStock - p.supplyTotal + p.withdrawTotal;
    }

    res.json({
      date: from && to ? `${from} — ${to}` : date || new Date().toISOString().slice(0, 10),
      from: from || null,
      to: to || null,
      summary: {
        totalUp,
        totalDown,
        netChange: totalUp - totalDown,
        moves: logs.length,
        clients: Array.from(clientsSet),
      },
      byProduct: Object.entries(byProductMap).map(([productId, d]) => ({
        productId,
        ...d,
      })),
      details: logs.map((l) => ({
        id: l.id,
        type: l.type,
        productId: l.productId,
        productName: l.product.name,
        change: l.change,
        oldStock: l.oldStock,
        newStock: l.newStock,
        clientName: l.clientName,
        salesName: l.salesName,
        notes: l.notes,
        referenceType: l.referenceType,
        referenceId: l.referenceId,
        createdAt: l.createdAt,
      })),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
