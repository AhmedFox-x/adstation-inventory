import { Router } from "express";
import { prisma } from "../config/database";
import { requireAuth, requirePermission, AuthRequest } from "../middleware/auth";
import { isEmail, isPhone, maxLength } from "../lib/validation";

const router = Router();

// ── GET /api/inventory/clients — list all clients ────────────────────────────
router.get("/clients", requireAuth, requirePermission("clients.view"), async (req, res) => {
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

    const [clients, total] = await Promise.all([
      prisma.client.findMany({
        where,
        include: { _count: { select: { withdrawalPermits: true } } },
        orderBy: { name: "asc" },
        skip,
        take: Number(limit),
      }),
      prisma.client.count({ where }),
    ]);

    res.json({
      clients,
      total,
      page: Number(page),
      pages: Math.ceil(total / Number(limit)),
    });
  } catch (err: any) {
    console.error("[Clients List] Error:", err?.message || err);
    if (!res.headersSent) res.status(500).json({ error: "Failed to list clients" });
  }
});

// ── GET /api/inventory/clients/:id — get client details ──────────────────────
router.get("/clients/:id", requireAuth, requirePermission("clients.view"), async (req, res) => {
  try {
    const client = await prisma.client.findUnique({
      where: { id: req.params.id },
      include: {
        priceList: true,
        withdrawalPermits: {
          include: { items: { include: { product: { select: { id: true, name: true, barcode: true } } } } },
          orderBy: { createdAt: "desc" },
          take: 20,
        },
        _count: { select: { withdrawalPermits: true, salesOrders: true } },
      },
    });

    if (!client) {
      res.status(404).json({ error: "Client not found" });
      return;
    }

    // Customer Intelligence: aggregate analytics over ALL non-deleted sales orders.
    const allSOs = await prisma.salesOrder.findMany({
      where: { clientId: client.id, deletedAt: null },
      select: { id: true, status: true, grandTotal: true, totalProfit: true, totalMarginPct: true, createdAt: true },
    });
    const completedStatuses = new Set(["confirmed", "processing", "shipped", "partial", "delivered", "closed", "completed"]);
    const completed = allSOs.filter((so) => completedStatuses.has(so.status));
    const totalRevenue = completed.reduce((s, so) => s + (so.grandTotal ?? 0), 0);
    let profitSum = 0;
    let profitCount = 0;
    for (const so of completed) {
      if (so.totalProfit !== null && so.totalProfit !== undefined) {
        profitSum += so.totalProfit;
        profitCount++;
      }
    }

    // Top purchased products by quantity across SO items.
    const soItems = await prisma.salesOrderItem.findMany({
      where: { order: { clientId: client.id, deletedAt: null } },
      select: { productId: true, orderedQty: true, totalPrice: true, productName: true, product: { select: { variant: true, name: true } } },
    });
    const prodMap = new Map<string, { name: string; variant: string | null; qty: number; value: number }>();
    for (const it of soItems) {
      const e = prodMap.get(it.productId) || { name: it.productName || it.product?.name || it.productId, variant: it.product?.variant ?? null, qty: 0, value: 0 };
      e.qty += it.orderedQty;
      e.value += it.totalPrice ?? 0;
      prodMap.set(it.productId, e);
    }
    const topProducts = Array.from(prodMap.entries())
      .map(([productId, d]) => ({ productId, ...d }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 10);

    const analytics = {
      totalSalesOrders: allSOs.length,
      completedSalesOrders: completed.length,
      openSalesOrders: allSOs.length - completed.length,
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      avgOrderValue: completed.length ? Math.round((totalRevenue / completed.length) * 100) / 100 : 0,
      totalProfit: profitCount ? Math.round(profitSum * 100) / 100 : null,
      avgMarginPct:
        profitCount && completed.length
          ? Math.round((completed.reduce((s, so) => s + (so.totalMarginPct ?? 0), 0) / profitCount) * 100) / 100
          : null,
      topProducts,
    };

    const [recentSalesOrders, recentReturns] = await Promise.all([
      prisma.salesOrder.findMany({
        where: { clientId: client.id, deletedAt: null },
        select: { id: true, orderNumber: true, status: true, grandTotal: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        take: 20,
      }),
      prisma.returnOrder.findMany({
        where: { partyId: client.id, deletedAt: null },
        select: { id: true, returnNumber: true, status: true, refundStatus: true, refundAmount: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        take: 20,
      }),
    ]);

    res.json({ ...client, analytics, recentSalesOrders, recentReturns });
  } catch (err: any) {
    console.error("[Client Detail] Error:", err?.message || err);
    if (!res.headersSent) res.status(500).json({ error: "Failed to get client" });
  }
});

// ── POST /api/inventory/clients — create client ──────────────────────────────
router.post("/clients", requireAuth, requirePermission("clients.create"), async (req: AuthRequest, res) => {
  try {
    const { name, phone, email, address, notes, priceListId } = req.body;

    if (!name || !name.trim()) {
      res.status(400).json({ error: "Client name is required", errorAr: "اسم العميل مطلوب" });
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

    // Check for duplicate client name
    const existing = await prisma.client.findFirst({ where: { name: name.trim() } });
    if (existing) {
      res.status(409).json({ error: "A client with this name already exists", errorAr: "يوجد عميل بنفس الاسم بالفعل" });
      return;
    }

    if (priceListId) {
      const pl = await prisma.priceList.findUnique({ where: { id: priceListId } });
      if (!pl || !pl.isActive) {
        res.status(400).json({ error: "Invalid priceListId" });
        return;
      }
    }

    const client = await prisma.client.create({
      data: {
        name: name.trim(),
        phone: phone?.trim() || null,
        email: email?.trim() || null,
        address: address?.trim() || null,
        notes: notes?.trim() || null,
        priceListId: priceListId || null,
      },
    });

    res.status(201).json({ client });
  } catch (err: any) {
    console.error("[Client Create] Error:", err?.message || err);
    if (!res.headersSent) res.status(500).json({ error: "Failed to create client" });
  }
});

// ── PATCH /api/inventory/clients/:id — update client ─────────────────────────
router.patch("/clients/:id", requireAuth, requirePermission("clients.edit"), async (req: AuthRequest, res) => {
  try {
    const { name, phone, email, address, notes, isActive, priceListId } = req.body;

    const existing = await prisma.client.findUnique({ where: { id: req.params.id } });
    if (!existing) {
      res.status(404).json({ error: "Client not found", errorAr: "العميل غير موجود" });
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

    // Check for duplicate client name (excluding current)
    if (name && name.trim() !== existing.name) {
      const duplicate = await prisma.client.findFirst({ where: { name: name.trim() } });
      if (duplicate) {
        res.status(409).json({ error: "A client with this name already exists", errorAr: "يوجد عميل بنفس الاسم بالفعل" });
        return;
      }
    }

    if (priceListId !== undefined) {
      if (priceListId) {
        const pl = await prisma.priceList.findUnique({ where: { id: priceListId } });
        if (!pl || !pl.isActive) {
          res.status(400).json({ error: "Invalid priceListId" });
          return;
        }
      } else {
        // الفراغ = فك ارتباط القائمة
      }
    }

    const client = await prisma.client.update({
      where: { id: req.params.id },
      data: {
        ...(name !== undefined && { name: name.trim() }),
        ...(phone !== undefined && { phone: phone?.trim() || null }),
        ...(email !== undefined && { email: email?.trim() || null }),
        ...(address !== undefined && { address: address?.trim() || null }),
        ...(notes !== undefined && { notes: notes?.trim() || null }),
        ...(isActive !== undefined && { isActive }),
        ...(priceListId !== undefined && { priceListId: priceListId || null }),
      },
    });

    res.json({ client });
  } catch (err: any) {
    console.error("[Client Update] Error:", err?.message || err);
    if (!res.headersSent) res.status(500).json({ error: "Failed to update client" });
  }
});

// ── DELETE /api/inventory/clients/:id — soft delete client ───────────────────
router.delete("/clients/:id", requireAuth, requirePermission("clients.delete"), async (req: AuthRequest, res) => {
  try {
    const existing = await prisma.client.findUnique({ where: { id: req.params.id } });
    if (!existing) {
      res.status(404).json({ error: "Client not found" });
      return;
    }

    const [permitCount, ordersCount, reservationsCount, returnsCount] = await Promise.all([
      prisma.withdrawalPermit.count({ where: { clientId: req.params.id } }),
      prisma.salesOrder.count({ where: { clientId: req.params.id } }),
      prisma.reservation.count({ where: { clientId: req.params.id } }),
      prisma.returnOrder.count({ where: { partyId: req.params.id } }),
    ]);
    const hasHistory = permitCount > 0 || ordersCount > 0 || reservationsCount > 0 || returnsCount > 0;
    if (hasHistory) {
      await prisma.client.update({ where: { id: req.params.id }, data: { isActive: false } });
      res.json({ message: "Client deactivated (has movement history)", soft: true });
    } else {
      // Hard delete مسموح فقط بدون أي تاريخ حركة (AGENT.md §3.4)
      await prisma.client.delete({ where: { id: req.params.id } });
      res.json({ message: "Client deleted", soft: false });
    }
  } catch (err: any) {
    console.error("[Client Delete] Error:", err?.message || err);
    if (!res.headersSent) res.status(500).json({ error: "Failed to delete client" });
  }
});

// ── POST /api/inventory/clients/seed — create clients from existing WithdrawalPermit names ──
router.post("/clients/seed", requireAuth, requirePermission("clients.create"), async (req: AuthRequest, res) => {
  try {
    const permits = await prisma.withdrawalPermit.findMany({
      where: { clientName: { gt: "" } },
      select: { clientName: true },
      distinct: ["clientName"],
    });

    const names = permits.map((p) => p.clientName!).filter(Boolean);
    let created = 0;

    for (const name of names) {
      const exists = await prisma.client.findFirst({ where: { name } });
      if (!exists) {
        await prisma.client.create({ data: { name } });
        created++;
      }
    }

    res.json({ message: `Seeded ${created} clients from existing data`, count: created, total: names.length });
  } catch (err: any) {
    console.error("[Client Seed] Error:", err?.message || err);
    if (!res.headersSent) res.status(500).json({ error: "Failed to seed clients" });
  }
});

export default router;
