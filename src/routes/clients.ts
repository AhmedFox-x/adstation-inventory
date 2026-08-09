import { Router } from "express";
import { prisma } from "../config/database";
import { requireAuth, requirePermission, AuthRequest } from "../middleware/auth";

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
        withdrawalPermits: {
          include: { items: { include: { product: { select: { id: true, name: true, barcode: true } } } } },
          orderBy: { createdAt: "desc" },
          take: 20,
        },
        _count: { select: { withdrawalPermits: true } },
      },
    });

    if (!client) {
      res.status(404).json({ error: "Client not found" });
      return;
    }

    res.json(client);
  } catch (err: any) {
    console.error("[Client Detail] Error:", err?.message || err);
    if (!res.headersSent) res.status(500).json({ error: "Failed to get client" });
  }
});

// ── POST /api/inventory/clients — create client ──────────────────────────────
router.post("/clients", requireAuth, requirePermission("clients.create"), async (req: AuthRequest, res) => {
  try {
    const { name, phone, email, address, notes } = req.body;

    if (!name || !name.trim()) {
      res.status(400).json({ error: "Client name is required" });
      return;
    }

    const client = await prisma.client.create({
      data: {
        name: name.trim(),
        phone: phone?.trim() || null,
        email: email?.trim() || null,
        address: address?.trim() || null,
        notes: notes?.trim() || null,
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
    const { name, phone, email, address, notes, isActive } = req.body;

    const existing = await prisma.client.findUnique({ where: { id: req.params.id } });
    if (!existing) {
      res.status(404).json({ error: "Client not found" });
      return;
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

    const permitCount = await prisma.withdrawalPermit.count({ where: { clientId: req.params.id } });
    if (permitCount > 0) {
      await prisma.client.update({ where: { id: req.params.id }, data: { isActive: false } });
      res.json({ message: "Client deactivated (has withdrawal permits)", soft: true });
    } else {
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
