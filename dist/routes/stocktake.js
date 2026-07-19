"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const database_1 = require("../config/database");
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
// ── GET /api/inventory/stocktake/sessions ───────────────────────────────────
router.get("/stocktake/sessions", auth_1.requireAuth, async (req, res, next) => {
    try {
        const { status, page = "1", limit = "20" } = req.query;
        const where = {};
        if (status)
            where.status = status;
        const [sessions, total] = await Promise.all([
            database_1.prisma.stocktakeSession.findMany({
                where,
                orderBy: { createdAt: "desc" },
                skip: (Number(page) - 1) * Number(limit),
                take: Number(limit),
                include: { _count: { select: { items: true } } },
            }),
            database_1.prisma.stocktakeSession.count({ where }),
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
    }
    catch (e) {
        next(e);
    }
});
// ── GET /api/inventory/stocktake/sessions/:id ───────────────────────────────
router.get("/stocktake/sessions/:id", auth_1.requireAuth, async (req, res, next) => {
    try {
        const session = await database_1.prisma.stocktakeSession.findUnique({
            where: { id: req.params.id },
            include: { items: true },
        });
        if (!session) {
            res.status(404).json({ error: "Session not found" });
            return;
        }
        res.json({ session });
    }
    catch (e) {
        next(e);
    }
});
// ── POST /api/inventory/stocktake/sessions ──────────────────────────────────
router.post("/stocktake/sessions", auth_1.requireAuth, async (req, res, next) => {
    try {
        const { name, notes, items } = req.body;
        if (!name) {
            res.status(400).json({ error: "Name is required" });
            return;
        }
        const session = await database_1.prisma.stocktakeSession.create({
            data: {
                name,
                userId: req.user?.userId || "",
                userName: req.user?.name || req.user?.email || "",
                notes: notes || null,
                items: items ? {
                    create: items.map((it) => ({
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
    }
    catch (e) {
        next(e);
    }
});
// ── PATCH /api/inventory/stocktake/sessions/:id ─────────────────────────────
router.patch("/stocktake/sessions/:id", auth_1.requireAuth, async (req, res, next) => {
    try {
        const { name, status, notes, items } = req.body;
        const existing = await database_1.prisma.stocktakeSession.findUnique({ where: { id: req.params.id } });
        if (!existing) {
            res.status(404).json({ error: "Session not found" });
            return;
        }
        const updateData = {};
        if (name !== undefined)
            updateData.name = name;
        if (status !== undefined)
            updateData.status = status;
        if (notes !== undefined)
            updateData.notes = notes;
        if (items && Array.isArray(items)) {
            await database_1.prisma.stocktakeItem.deleteMany({ where: { sessionId: req.params.id } });
            await database_1.prisma.stocktakeItem.createMany({
                data: items.map((it) => ({
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
        const session = await database_1.prisma.stocktakeSession.update({
            where: { id: req.params.id },
            data: updateData,
            include: { items: true },
        });
        res.json({ session });
    }
    catch (e) {
        next(e);
    }
});
// ── DELETE /api/inventory/stocktake/sessions/:id ────────────────────────────
router.delete("/stocktake/sessions/:id", auth_1.requireAuth, async (req, res, next) => {
    try {
        await database_1.prisma.stocktakeSession.delete({ where: { id: req.params.id } });
        res.json({ success: true });
    }
    catch (e) {
        next(e);
    }
});
exports.default = router;
//# sourceMappingURL=stocktake.js.map