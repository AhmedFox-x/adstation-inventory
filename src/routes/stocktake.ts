import { Router } from "express";
import { prisma } from "../config/database";
import { requireAuth } from "../middleware/auth";

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
        countedItems: 0,
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
router.post("/stocktake/sessions", requireAuth, async (req: any, res, next) => {
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
          })),
        } : undefined,
      },
      include: { items: true },
    });

    res.json({ session });
  } catch (e) { next(e); }
});

// ── PATCH /api/inventory/stocktake/sessions/:id ─────────────────────────────
router.patch("/stocktake/sessions/:id", requireAuth, async (req: any, res, next) => {
  try {
    const { name, status, notes, items } = req.body;
    const existing = await prisma.stocktakeSession.findUnique({ where: { id: req.params.id } });
    if (!existing) { res.status(404).json({ error: "Session not found" }); return; }

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

// ── DELETE /api/inventory/stocktake/sessions/:id ────────────────────────────
router.delete("/stocktake/sessions/:id", requireAuth, async (req, res, next) => {
  try {
    await prisma.stocktakeSession.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (e) { next(e); }
});

export default router;
