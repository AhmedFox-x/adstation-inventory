import { Router } from "express";
import { prisma } from "../config/database";
import { requireAuth, requirePermission, AuthRequest } from "../middleware/auth";
import { isEmail, isPhone, maxLength } from "../lib/validation";

const router = Router();

// ── GET /api/inventory/suppliers — list all suppliers ────────────────────────
router.get("/suppliers", requireAuth, requirePermission("suppliers.view"), async (req, res) => {
  try {
    const { search, page = "1", limit = "50" } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    const where: any = {};
    if (search && typeof search === "string") {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { phone: { contains: search, mode: "insensitive" } },
        { email: { contains: search, mode: "insensitive" } },
      ];
    }

    const [suppliers, total] = await Promise.all([
      prisma.supplier.findMany({
        where,
        include: { _count: { select: { purchaseOrders: true, supplyPermits: true } } },
        orderBy: { name: "asc" },
        skip,
        take: Number(limit),
      }),
      prisma.supplier.count({ where }),
    ]);

    res.json({
      suppliers,
      total,
      page: Number(page),
      pages: Math.ceil(total / Number(limit)),
    });
  } catch (err: any) {
    console.error("[Suppliers List] Error:", err?.message || err);
    if (!res.headersSent) res.status(500).json({ error: "Failed to list suppliers" });
  }
});

// ── GET /api/inventory/suppliers/:id — get supplier details ──────────────────
router.get("/suppliers/:id", requireAuth, requirePermission("suppliers.view"), async (req, res) => {
  try {
    const supplier = await prisma.supplier.findUnique({
      where: { id: req.params.id },
      include: {
        purchaseOrders: {
          include: { items: { include: { product: { select: { id: true, name: true, barcode: true } } } } },
          orderBy: { createdAt: "desc" },
          take: 20,
        },
        _count: { select: { purchaseOrders: true, supplyPermits: true } },
      },
    });

    if (!supplier) {
      res.status(404).json({ error: "Supplier not found" });
      return;
    }

    // Supplier Intelligence: aggregated analytics over ALL non-deleted purchase orders.
    const allPOs = await prisma.purchaseOrder.findMany({
      where: { supplierId: supplier.id, deletedAt: null },
      select: { id: true, status: true, grandTotal: true, orderDate: true, expectedDeliveryDate: true, actualDeliveryDate: true, createdAt: true },
    });

    const receivedStatuses = new Set(["received", "approved", "confirmed", "closed", "completed"]);
    const closedPOs = allPOs.filter((po) => receivedStatuses.has(po.status));
    const totalSpend = closedPOs.reduce((s, po) => s + (po.grandTotal ?? 0), 0);

    // On-time delivery rate + average lead time (days between orderDate and expectedDeliveryDate).
    let onTime = 0;
    let leadSum = 0;
    let leadCount = 0;
    for (const po of allPOs) {
      if (po.expectedDeliveryDate && po.actualDeliveryDate) {
        if (po.actualDeliveryDate <= po.expectedDeliveryDate) onTime++;
      }
      if (po.orderDate && po.expectedDeliveryDate) {
        leadSum += Math.max(0, (po.expectedDeliveryDate.getTime() - po.orderDate.getTime()) / 86400000);
        leadCount++;
      }
    }

    // Most purchased products across all PO items.
    const poItems = await prisma.purchaseOrderItem.findMany({
      where: { order: { supplierId: supplier.id, deletedAt: null } },
      select: { productId: true, quantity: true, unitPrice: true, product: { select: { name: true, variant: true, barcode: true } } },
    });
    const prodMap = new Map<string, { name: string; variant: string | null; qty: number; value: number }>();
    for (const it of poItems) {
      const e = prodMap.get(it.productId) || { name: it.product.name, variant: it.product.variant, qty: 0, value: 0 };
      e.qty += it.quantity;
      e.value += (it.quantity || 0) * (it.unitPrice || 0);
      prodMap.set(it.productId, e);
    }
    const topProducts = Array.from(prodMap.entries())
      .map(([productId, d]) => ({ productId, ...d }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 10);

    const analytics = {
      totalPurchaseOrders: allPOs.length,
      closedPurchaseOrders: closedPOs.length,
      openPurchaseOrders: allPOs.length - closedPOs.length,
      totalSpend: Math.round(totalSpend * 100) / 100,
      avgOrderValue: closedPOs.length ? Math.round((totalSpend / closedPOs.length) * 100) / 100 : 0,
      onTimeDeliveryRate: onTime > 0 ? Math.round((onTime / Math.max(1, allPOs.filter((p) => p.actualDeliveryDate).length)) * 100) / 100 : null,
      avgLeadTimeDays: leadCount ? Math.round((leadSum / leadCount) * 10) / 10 : null,
      topProducts,
      costHistoryCount: await prisma.costHistory.count({ where: { referenceType: "purchase_order", referenceId: { in: allPOs.map((p) => p.id) } } }),
    };

    // Supplier Intelligence: آخر أسعار شراء لكل منتج (Price History) — من أحدث عنصر PO لكل منتج.
    const recentItems = await prisma.purchaseOrderItem.findMany({
      where: { order: { supplierId: supplier.id, deletedAt: null } },
      select: { productId: true, unitPrice: true, orderId: true },
      orderBy: { order: { createdAt: "desc" } },
      take: 500,
    });
    const poDates = new Map(allPOs.map((p) => [p.id, p.createdAt]));
    const priceHistoryMap = new Map<string, { productId: string; unitPrice: number; orderId: string; orderedAt: string }>();
    for (const it of recentItems) {
      if (!priceHistoryMap.has(it.productId) && it.unitPrice && it.unitPrice > 0) {
        priceHistoryMap.set(it.productId, { productId: it.productId, unitPrice: it.unitPrice, orderId: it.orderId, orderedAt: poDates.get(it.orderId)?.toISOString() ?? "" });
      }
    }
    const priceHistory = await Promise.all(
      Array.from(priceHistoryMap.values()).map(async (ph) => {
        const p = await prisma.product.findUnique({ where: { id: ph.productId }, select: { name: true, sku: true, variant: true } });
        return { ...ph, name: p?.name || "", sku: p?.sku || null, variant: p?.variant || null };
      })
    );

    const recentSupplyPermits = await prisma.supplyPermit.findMany({
      where: { supplierId: supplier.id, deletedAt: null },
      orderBy: { createdAt: "desc" },
      take: 20,
      include: { _count: { select: { items: true } } },
    });

    const recentPurchaseOrders = (
      await prisma.purchaseOrder.findMany({
        where: { supplierId: supplier.id, deletedAt: null },
        select: { id: true, orderNumber: true, status: true, grandTotal: true, createdAt: true, expectedDeliveryDate: true },
        orderBy: { createdAt: "desc" },
        take: 20,
      })
    ).map((o) => ({ ...o, poNumber: o.orderNumber }));

    res.json({ ...supplier, analytics, priceHistory, recentSupplyPermits, recentPurchaseOrders });
  } catch (err: any) {
    console.error("[Supplier Detail] Error:", err?.message || err);
    if (!res.headersSent) res.status(500).json({ error: "Failed to get supplier" });
  }
});

// ── POST /api/inventory/suppliers — create supplier ──────────────────────────
router.post("/suppliers", requireAuth, requirePermission("suppliers.create"), async (req: AuthRequest, res) => {
  try {
    const { name, phone, email, address, paymentTerms, notes } = req.body;

    if (!name || !name.trim()) {
      res.status(400).json({ error: "Supplier name is required", errorAr: "اسم المورد مطلوب" });
      return;
    }

    // Validate email format if provided
    if (email) {
      const emailResult = isEmail(email, "Email");
      if (!emailResult.valid) {
        res.status(400).json({ error: emailResult.error, errorAr: emailResult.errorAr });
        return;
      }
    }

    // Validate phone format if provided
    if (phone) {
      const phoneResult = isPhone(phone, "Phone");
      if (!phoneResult.valid) {
        res.status(400).json({ error: phoneResult.error, errorAr: phoneResult.errorAr });
        return;
      }
    }

    // Validate name length
    const nameResult = maxLength(name, "Name", 200);
    if (!nameResult.valid) {
      res.status(400).json({ error: nameResult.error, errorAr: nameResult.errorAr });
      return;
    }

    // Check for duplicate supplier name
    const existingSupplier = await prisma.supplier.findFirst({ where: { name: name.trim() } });
    if (existingSupplier) {
      res.status(409).json({ error: "A supplier with this name already exists", errorAr: "يوجد مورد بنفس الاسم بالفعل" });
      return;
    }

    const supplier = await prisma.supplier.create({
      data: {
        name: name.trim(),
        phone: phone?.trim() || null,
        email: email?.trim() || null,
        address: address?.trim() || null,
        paymentTerms: paymentTerms?.trim() || null,
        notes: notes?.trim() || null,
      },
    });

    res.status(201).json({ supplier });
  } catch (err: any) {
    console.error("[Supplier Create] Error:", err?.message || err);
    if (!res.headersSent) res.status(500).json({ error: "Failed to create supplier" });
  }
});

// ── PATCH /api/inventory/suppliers/:id — update supplier ─────────────────────
router.patch("/suppliers/:id", requireAuth, requirePermission("suppliers.edit"), async (req: AuthRequest, res) => {
  try {
    const { name, phone, email, address, paymentTerms, notes, isActive } = req.body;

    const existing = await prisma.supplier.findUnique({ where: { id: req.params.id } });
    if (!existing) {
      res.status(404).json({ error: "Supplier not found", errorAr: "المورد غير موجود" });
      return;
    }

    // Validate email format if provided
    if (email) {
      const emailResult = isEmail(email, "Email");
      if (!emailResult.valid) {
        res.status(400).json({ error: emailResult.error, errorAr: emailResult.errorAr });
        return;
      }
    }

    // Validate phone format if provided
    if (phone) {
      const phoneResult = isPhone(phone, "Phone");
      if (!phoneResult.valid) {
        res.status(400).json({ error: phoneResult.error, errorAr: phoneResult.errorAr });
        return;
      }
    }

    // Validate name length if provided
    if (name) {
      const nameResult = maxLength(name, "Name", 200);
      if (!nameResult.valid) {
        res.status(400).json({ error: nameResult.error, errorAr: nameResult.errorAr });
        return;
      }
    }

    // Check for duplicate supplier name (excluding current)
    if (name && name.trim() !== existing.name) {
      const duplicate = await prisma.supplier.findFirst({ where: { name: name.trim() } });
      if (duplicate) {
        res.status(409).json({ error: "A supplier with this name already exists", errorAr: "يوجد مورد بنفس الاسم بالفعل" });
        return;
      }
    }

    const supplier = await prisma.supplier.update({
      where: { id: req.params.id },
      data: {
        ...(name !== undefined && { name: name.trim() }),
        ...(phone !== undefined && { phone: phone?.trim() || null }),
        ...(email !== undefined && { email: email?.trim() || null }),
        ...(address !== undefined && { address: address?.trim() || null }),
        ...(paymentTerms !== undefined && { paymentTerms: paymentTerms?.trim() || null }),
        ...(notes !== undefined && { notes: notes?.trim() || null }),
        ...(isActive !== undefined && { isActive }),
      },
    });

    res.json({ supplier });
  } catch (err: any) {
    console.error("[Supplier Update] Error:", err?.message || err);
    if (!res.headersSent) res.status(500).json({ error: "Failed to update supplier" });
  }
});

// ── DELETE /api/inventory/suppliers/:id — soft delete supplier ───────────────
router.delete("/suppliers/:id", requireAuth, requirePermission("suppliers.delete"), async (req: AuthRequest, res) => {
  try {
    const existing = await prisma.supplier.findUnique({ where: { id: req.params.id } });
    if (!existing) {
      res.status(404).json({ error: "Supplier not found" });
      return;
    }

    // Check if supplier has purchase orders
    const poCount = await prisma.purchaseOrder.count({ where: { supplierId: req.params.id } });
    if (poCount > 0) {
      // Soft delete — just deactivate
      await prisma.supplier.update({ where: { id: req.params.id }, data: { isActive: false } });
      res.json({ message: "Supplier deactivated (has purchase orders)", soft: true });
    } else {
      // Hard delete — no purchase orders
      await prisma.supplier.delete({ where: { id: req.params.id } });
      res.json({ message: "Supplier deleted", soft: false });
    }
  } catch (err: any) {
    console.error("[Supplier Delete] Error:", err?.message || err);
    if (!res.headersSent) res.status(500).json({ error: "Failed to delete supplier" });
  }
});

// ── POST /api/inventory/suppliers/seed — create suppliers from existing SupplyPermit names ──
router.post("/suppliers/seed", requireAuth, requirePermission("suppliers.create"), async (req: AuthRequest, res) => {
  try {
    // Get unique supplier names from SupplyPermit
    const permits = await prisma.supplyPermit.findMany({
      where: { supplierName: { not: null } },
      select: { supplierName: true },
      distinct: ["supplierName"],
    });

    const names = permits.map(p => p.supplierName!).filter(Boolean);
    let created = 0;

    for (const name of names) {
      const exists = await prisma.supplier.findFirst({ where: { name } });
      if (!exists) {
        await prisma.supplier.create({ data: { name } });
        created++;
      }
    }

    res.json({ message: `Seeded ${created} suppliers from existing data`, count: created, total: names.length });
  } catch (err: any) {
    console.error("[Supplier Seed] Error:", err?.message || err);
    if (!res.headersSent) res.status(500).json({ error: "Failed to seed suppliers" });
  }
});

export default router;
