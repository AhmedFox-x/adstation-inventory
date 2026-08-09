import { Router } from "express";
import { prisma } from "../config/database";
import { requireAuth, requirePermission } from "../middleware/auth";

const router = Router();

// ── GET /api/inventory/stocktake/sessions ───────────────────────────────────
router.get("/stocktake/sessions", requireAuth, async (req, res, next) => {
  try {
    const { status, page = "1", limit = "20" } = req.query as Record<string, string>;
    const where: any = {};
    if (status) where.status = status;

    const [sessions, total] = await Promise.all([
      prisma.stocktakeSession.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (Number(page) - 1) * Number(limit),
        take: Number(limit),
        include: { _count: { select: { items: true } } },
      }),
      prisma.stocktakeSession.count({ where }),
    ]);

    res.json({
      sessions: sessions.map(s => ({
        id: s.id,
        name: s.name,
        status: s.status,
        userId: s.userId,
        userName: s.userName,
        date: s.date,
        notes: s.notes,
        itemCount: s._count.items,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      })),
      total,
      page: Number(page),
      pages: Math.ceil(total / Number(limit)),
    });
  } catch (e) { next(e); }
});

// ── GET /api/inventory/stocktake/sessions/:id ───────────────────────────────
router.get("/stocktake/sessions/:id", requireAuth, async (req, res, next) => {
  try {
    const session = await prisma.stocktakeSession.findUnique({
      where: { id: req.params.id },
      include: { items: true },
    });
    if (!session) { res.status(404).json({ error: "Session not found" }); return; }
    res.json({ session });
  } catch (e) { next(e); }
});

// ── POST /api/inventory/stocktake/sessions ──────────────────────────────────
router.post("/stocktake/sessions", requireAuth, requirePermission("stocktake.create"), async (req: any, res, next) => {
  try {
    const { name, notes, items } = req.body;
    if (!name) { res.status(400).json({ error: "Name is required" }); return; }

    const session = await prisma.stocktakeSession.create({
      data: {
        name,
        userId: req.user?.userId || "",
        userName: req.user?.name || req.user?.email || "",
        notes: notes || null,
        items: items ? {
          create: items.map((it: any) => ({
            productId: it.productId,
            productName: it.productName,
            productSku: it.productSku || null,
            productVariant: it.productVariant || null,
            category: it.category || null,
            systemStock: it.systemStock,
            actualCount: it.actualCount ?? null,
            note: it.note || null,
            exclusionReason: it.exclusionReason || null,
            flaggedRecount: it.flaggedRecount || false,
          })),
        } : undefined,
      },
      include: { items: true },
    });

    res.json({ session });
  } catch (e) { next(e); }
});

// ── PATCH /api/inventory/stocktake/sessions/:id ─────────────────────────────
router.patch("/stocktake/sessions/:id", requireAuth, requirePermission("stocktake.create"), async (req: any, res, next) => {
  try {
    const { name, status, notes, items } = req.body;
    const existing = await prisma.stocktakeSession.findUnique({ where: { id: req.params.id } });
    if (!existing) { res.status(404).json({ error: "Session not found" }); return; }
    if (existing.status === "completed") { res.status(400).json({ error: "Session already approved" }); return; }

    const updateData: any = {};
    if (name !== undefined) updateData.name = name;
    if (status !== undefined) updateData.status = status;
    if (notes !== undefined) updateData.notes = notes;

    if (items && Array.isArray(items)) {
      await prisma.stocktakeItem.deleteMany({ where: { sessionId: req.params.id } });
      await prisma.stocktakeItem.createMany({
        data: items.map((it: any) => ({
          sessionId: req.params.id,
          productId: it.productId,
          productName: it.productName,
          productSku: it.productSku || null,
          productVariant: it.productVariant || null,
          category: it.category || null,
          systemStock: it.systemStock,
          actualCount: it.actualCount ?? null,
          note: it.note || null,
          exclusionReason: it.exclusionReason || null,
          flaggedRecount: it.flaggedRecount || false,
        })),
      });
    }

    const session = await prisma.stocktakeSession.update({
      where: { id: req.params.id },
      data: updateData,
      include: { items: true },
    });

    res.json({ session });
  } catch (e) { next(e); }
});

// ── POST /api/inventory/stocktake/sessions/:id/approve ──────────────────────
router.post("/stocktake/sessions/:id/approve", requireAuth, requirePermission("stocktake.approve"), async (req: any, res, next) => {
  try {
    const session = await prisma.stocktakeSession.findUnique({
      where: { id: req.params.id },
      include: { items: true },
    });
    if (!session) { res.status(404).json({ error: "Session not found" }); return; }
    if (session.status === "completed") { res.status(400).json({ error: "Session already approved" }); return; }

    const countable = session.items.filter(it => it.actualCount !== null && !it.exclusionReason);
    if (countable.length === 0) { res.status(400).json({ error: "No counted items to approve" }); return; }

    let updated = 0;
    let totalIncrease = 0;
    let totalDecrease = 0;
    const logs: any[] = [];

    for (const item of countable) {
      const product = await prisma.product.findUnique({ where: { id: item.productId } });
      if (!product) continue;

      const oldStock = product.stock;
      const newStock = item.actualCount!;
      const change = newStock - oldStock;

      if (change === 0) continue;

      await prisma.product.update({
        where: { id: item.productId },
        data: { stock: newStock },
      });

      const log = await prisma.inventoryLog.create({
        data: {
          type: "stocktake",
          productId: item.productId,
          oldStock,
          newStock,
          change,
          notes: item.note || null,
          referenceType: "stocktake",
          referenceId: session.id,
        },
      });

      logs.push(log);
      updated++;
      if (change > 0) totalIncrease += change;
      if (change < 0) totalDecrease += Math.abs(change);
    }

    await prisma.stocktakeSession.update({
      where: { id: req.params.id },
      data: { status: "completed" },
    });

    res.json({
      summary: {
        sessionId: session.id,
        sessionName: session.name,
        totalProducts: countable.length,
        updatedProducts: updated,
        totalIncrease,
        totalDecrease,
        logsCreated: logs.length,
      },
    });
  } catch (e) { next(e); }
});

// ── DELETE /api/inventory/stocktake/sessions/:id ────────────────────────────
router.delete("/stocktake/sessions/:id", requireAuth, requirePermission("stocktake.approve"), async (req, res, next) => {
  try {
    await prisma.stocktakeSession.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (e) { next(e); }
});

export default router;
