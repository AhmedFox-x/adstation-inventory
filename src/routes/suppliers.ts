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

    res.json(supplier);
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
