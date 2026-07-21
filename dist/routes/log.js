"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const database_1 = require("../config/database");
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
// ── GET /api/inventory/log ────────────────────────────────────────────────────
router.get("/log", auth_1.requireAuth, async (req, res, next) => {
    try {
        const { date, type, search, page = "1", limit = "20" } = req.query;
        const where = {};
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
                database_1.prisma.withdrawalPermit.findMany({
                    where: {
                        OR: [
                            { permitNumber: { contains: search } },
                            { permitNumberOrig: { contains: search } },
                        ],
                    },
                    select: { id: true },
                }),
                database_1.prisma.supplyPermit.findMany({
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
            database_1.prisma.inventoryLog.findMany({
                where,
                include: { product: { select: { name: true } } },
                orderBy: { createdAt: "desc" },
                skip,
                take,
            }),
            database_1.prisma.inventoryLog.count({ where }),
        ]);
        // Fetch permit numbers for each log
        const logsWithPermit = await Promise.all(logs.map(async (l) => {
            let permitNumber = null;
            let permitNumberOrig = null;
            if (l.referenceType === "withdrawal" && l.referenceId) {
                const w = await database_1.prisma.withdrawalPermit.findUnique({
                    where: { id: l.referenceId },
                    select: { permitNumber: true, permitNumberOrig: true },
                });
                permitNumber = w?.permitNumber || null;
                permitNumberOrig = w?.permitNumberOrig || null;
            }
            else if (l.referenceType === "supply" && l.referenceId) {
                const s = await database_1.prisma.supplyPermit.findUnique({
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
        }));
        res.json({
            logs: logsWithPermit,
            pagination: {
                page: Number(page),
                limit: take,
                total,
                pages: Math.ceil(total / take),
            },
        });
    }
    catch (err) {
        next(err);
    }
});
// ── GET /api/inventory/log/:id — Full detail with permit + image ─────────────
router.get("/log/:id", auth_1.requireAuth, async (req, res, next) => {
    try {
        const { id } = req.params;
        const log = await database_1.prisma.inventoryLog.findUnique({
            where: { id },
            include: { product: { select: { name: true, variant: true, sku: true } } },
        });
        if (!log) {
            res.status(404).json({ error: "Log entry not found" });
            return;
        }
        let permit = null;
        let items = [];
        if (log.referenceType === "withdrawal" && log.referenceId) {
            const w = await database_1.prisma.withdrawalPermit.findUnique({
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
        }
        else if (log.referenceType === "supply" && log.referenceId) {
            const s = await database_1.prisma.supplyPermit.findUnique({
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
    }
    catch (err) {
        next(err);
    }
});
// ── GET /api/inventory/report ─────────────────────────────────────────────────
router.get("/report", auth_1.requireAuth, async (req, res, next) => {
    try {
        const dateParam = req.query.date;
        const targetDate = dateParam || new Date().toISOString().slice(0, 10);
        const dayStart = new Date(targetDate);
        dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(targetDate);
        dayEnd.setHours(23, 59, 59, 999);
        const logs = await database_1.prisma.inventoryLog.findMany({
            where: {
                createdAt: { gte: dayStart, lte: dayEnd },
            },
            include: { product: { select: { name: true } } },
            orderBy: { createdAt: "desc" },
        });
        // Summary
        let totalUp = 0;
        let totalDown = 0;
        const clientsSet = new Set();
        // By product
        const byProductMap = {};
        for (const log of logs) {
            if (log.change > 0)
                totalUp += log.change;
            else
                totalDown += Math.abs(log.change);
            if (log.clientName)
                clientsSet.add(log.clientName);
            if (!byProductMap[log.productId]) {
                byProductMap[log.productId] = {
                    name: log.product.name,
                    before: log.oldStock,
                    after: log.newStock,
                    delta: 0,
                    moves: 0,
                };
            }
            byProductMap[log.productId].after = log.newStock;
            byProductMap[log.productId].delta += log.change;
            byProductMap[log.productId].moves += 1;
        }
        res.json({
            date: targetDate,
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
                createdAt: l.createdAt,
            })),
        });
    }
    catch (err) {
        next(err);
    }
});
// ── DELETE /api/inventory/log/:id — Delete a single log entry + its permit ───
router.delete("/log/:id", auth_1.requireAuth, async (req, res, next) => {
    try {
        const { id } = req.params;
        const log = await database_1.prisma.inventoryLog.findUnique({ where: { id } });
        if (!log) {
            res.status(404).json({ error: "Log entry not found" });
            return;
        }
        if (log.referenceType === "withdrawal" && log.referenceId) {
            await database_1.prisma.withdrawalItem.deleteMany({ where: { permitId: log.referenceId } });
            await database_1.prisma.withdrawalPermit.delete({ where: { id: log.referenceId } });
        }
        else if (log.referenceType === "supply" && log.referenceId) {
            await database_1.prisma.supplyItem.deleteMany({ where: { permitId: log.referenceId } });
            await database_1.prisma.supplyPermit.delete({ where: { id: log.referenceId } });
        }
        await database_1.prisma.inventoryLog.delete({ where: { id } });
        res.json({ success: true });
    }
    catch (err) {
        next(err);
    }
});
// ── DELETE /api/inventory/log — Delete ALL logs and permits ───────────────────
router.delete("/log", auth_1.requireAuth, async (req, res, next) => {
    try {
        await database_1.prisma.withdrawalItem.deleteMany();
        await database_1.prisma.supplyItem.deleteMany();
        await database_1.prisma.withdrawalPermit.deleteMany();
        await database_1.prisma.supplyPermit.deleteMany();
        const { count } = await database_1.prisma.inventoryLog.deleteMany();
        res.json({ success: true, deleted: count });
    }
    catch (err) {
        next(err);
    }
});
exports.default = router;
//# sourceMappingURL=log.js.map