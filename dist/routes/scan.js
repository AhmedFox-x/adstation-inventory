"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const database_1 = require("../config/database");
const auth_1 = require("../middleware/auth");
const gemini_1 = require("../utils/gemini");
const fuzzy_1 = require("../utils/fuzzy");
const router = (0, express_1.Router)();
// ── POST /api/inventory/scan ──────────────────────────────────────────────────
router.post("/scan", auth_1.requireAuth, async (req, res) => {
    try {
        const { image, mimeType } = req.body;
        if (!image) {
            res.status(400).json({ error: "Image data is required" });
            return;
        }
        if (typeof image !== "string" || image.length < 100) {
            res.status(400).json({ error: "Invalid image data" });
            return;
        }
        console.log(`[Scan] Starting scan — image size: ${Math.round(image.length / 1024)}KB, mime: ${mimeType}`);
        // Get all products for fuzzy matching
        const products = await database_1.prisma.product.findMany({
            select: { id: true, name: true, variant: true, stock: true },
        });
        // Call Gemini
        const result = await (0, gemini_1.analyzeImageWithGemini)(image, mimeType || "image/jpeg");
        console.log(`[Scan] Gemini returned ${result.items.length} items, ${result.errors.length} errors, ${result.warnings.length} warnings`);
        // Match each detected item against products
        const detected = [];
        for (const item of result.items) {
            const m = (0, fuzzy_1.bestMatch)(item.name, products);
            if (m.product && m.score > 0.4) {
                detected.push({
                    rawName: item.name,
                    qty: item.qty,
                    confidence: item.confidence,
                    error: item.error,
                    productId: m.product.id,
                    matchScore: m.score,
                    isNew: false,
                });
            }
            else {
                // New product — do NOT auto-create, just flag as new
                detected.push({
                    rawName: item.name,
                    qty: item.qty,
                    confidence: item.confidence,
                    error: item.error,
                    productId: "",
                    matchScore: 0,
                    isNew: true,
                });
            }
        }
        res.json({
            detected,
            orderDate: result.orderDate || "",
            deliveryDate: result.deliveryDate || "",
            permitNumber: result.permitNumber || "",
            errors: result.errors || [],
            warnings: result.warnings || [],
        });
    }
    catch (err) {
        console.error("[Scan] Error:", err?.message || err);
        if (!res.headersSent) {
            res.status(500).json({ error: err?.message || "Scan analysis failed" });
        }
    }
});
// ── POST /api/inventory/scan/confirm ──────────────────────────────────────────
router.post("/scan/confirm", auth_1.requireAuth, async (req, res) => {
    try {
        const { type, clientName, salesName, supplierName, notes, items, image, mimeType, orderDate, deliveryDate, permitNumber: permitNumberOrig, operationType, } = req.body;
        if (!items || !Array.isArray(items) || items.length === 0) {
            res.status(400).json({ error: "At least one item is required" });
            return;
        }
        if (type === "withdraw") {
            // Execute as withdrawal
            const productIds = items.map((it) => it.productId).filter(Boolean);
            const products = await database_1.prisma.product.findMany({
                where: { id: { in: productIds } },
            });
            const productMap = new Map(products.map((p) => [p.id, p]));
            // Check shortages
            const shortages = [];
            for (const item of items) {
                const product = productMap.get(item.productId);
                if (!product)
                    continue;
                const requested = Number(item.quantityActual);
                if (requested > product.stock) {
                    shortages.push({
                        productId: item.productId,
                        productName: product.name,
                        available: product.stock,
                        requested,
                    });
                }
            }
            if (shortages.length > 0) {
                res.json({ status: "partial", shortages });
                return;
            }
            // Execute
            const d = new Date();
            const permitNumber = `W-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-000`;
            const permit = await database_1.prisma.$transaction(async (tx) => {
                const todayPrefix = permitNumber.slice(0, -3);
                const lastPermit = await tx.withdrawalPermit.findFirst({
                    where: { permitNumber: { startsWith: todayPrefix } },
                    orderBy: { permitNumber: "desc" },
                });
                const seq = lastPermit
                    ? parseInt(lastPermit.permitNumber.slice(-3), 10) + 1
                    : 1;
                const finalNumber = `${todayPrefix}${String(seq).padStart(3, "0")}`;
                const p = await tx.withdrawalPermit.create({
                    data: {
                        permitNumber: finalNumber,
                        clientName: clientName || "Scan",
                        salesName: salesName || null,
                        notes: notes || null,
                        status: "completed",
                        imageBase64: image || null,
                        imageMimeType: mimeType || null,
                        orderDate: orderDate || null,
                        deliveryDate: deliveryDate || null,
                        permitNumberOrig: permitNumberOrig || null,
                        operationType: operationType || null,
                    },
                });
                let firstProductId = "";
                for (const item of items) {
                    const product = productMap.get(item.productId);
                    if (!product)
                        continue;
                    const qty = Math.min(Number(item.quantityActual), product.stock);
                    if (qty <= 0)
                        continue;
                    const before = product.stock;
                    const after = product.stock - qty;
                    await tx.product.update({
                        where: { id: item.productId },
                        data: { stock: after },
                    });
                    await tx.withdrawalItem.create({
                        data: {
                            permitId: p.id,
                            productId: item.productId,
                            quantityRequested: Number(item.quantityActual),
                            quantityActual: qty,
                        },
                    });
                    await tx.inventoryLog.create({
                        data: {
                            type: "withdraw",
                            productId: item.productId,
                            oldStock: before,
                            newStock: after,
                            change: -qty,
                            clientName: clientName || null,
                            salesName: salesName || null,
                            notes: notes || null,
                            referenceType: "withdrawal",
                            referenceId: p.id,
                        },
                    });
                    if (!firstProductId)
                        firstProductId = item.productId;
                }
                return p;
            });
            res.status(201).json({ status: "completed", permit });
        }
        else {
            // Execute as supply
            const d = new Date();
            const permitNumber = `S-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-000`;
            const permit = await database_1.prisma.$transaction(async (tx) => {
                const todayPrefix = permitNumber.slice(0, -3);
                const lastPermit = await tx.supplyPermit.findFirst({
                    where: { permitNumber: { startsWith: todayPrefix } },
                    orderBy: { permitNumber: "desc" },
                });
                const seq = lastPermit
                    ? parseInt(lastPermit.permitNumber.slice(-3), 10) + 1
                    : 1;
                const finalNumber = `${todayPrefix}${String(seq).padStart(3, "0")}`;
                const p = await tx.supplyPermit.create({
                    data: {
                        permitNumber: finalNumber,
                        supplierName: supplierName || salesName || null,
                        salesName: salesName || null,
                        clientName: clientName || null,
                        notes: notes || null,
                        imageBase64: image || null,
                        imageMimeType: mimeType || null,
                        orderDate: orderDate || null,
                        deliveryDate: deliveryDate || null,
                        permitNumberOrig: permitNumberOrig || null,
                    },
                });
                let firstProductId = "";
                for (const item of items) {
                    let product;
                    // If no productId, create the product first
                    if (!item.productId || item.productId === "") {
                        const productName = item.editedName?.trim() || item.rawName || item.name || "New Product";
                        product = await tx.product.create({
                            data: {
                                name: productName,
                                stock: 0,
                                minStock: 10,
                            },
                        });
                    }
                    else {
                        product = await tx.product.findUnique({
                            where: { id: item.productId },
                        });
                    }
                    if (!product)
                        continue;
                    const qty = Number(item.quantityActual);
                    if (qty <= 0)
                        continue;
                    const before = product.stock;
                    const after = product.stock + qty;
                    await tx.product.update({
                        where: { id: product.id },
                        data: { stock: after },
                    });
                    await tx.supplyItem.create({
                        data: {
                            permitId: p.id,
                            productId: product.id,
                            quantity: qty,
                        },
                    });
                    await tx.inventoryLog.create({
                        data: {
                            type: "supply",
                            productId: product.id,
                            oldStock: before,
                            newStock: after,
                            change: qty,
                            notes: notes || null,
                            referenceType: "supply",
                            referenceId: p.id,
                        },
                    });
                    if (!firstProductId)
                        firstProductId = product.id;
                }
                return p;
            });
            res.status(201).json({ status: "completed", permit });
        }
    }
    catch (err) {
        console.error("[Scan Confirm] Error:", err?.message || err);
        if (!res.headersSent) {
            res.status(500).json({ error: err?.message || "Failed to process permit" });
        }
    }
});
exports.default = router;
//# sourceMappingURL=scan.js.map