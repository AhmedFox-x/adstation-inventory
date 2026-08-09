import { Router } from "express";
import { prisma } from "../config/database";
import { requireAuth, requirePermission, AuthRequest } from "../middleware/auth";
import { ALL_PERMISSIONS } from "../utils/permissions";
import { upsertDefaultRoles } from "../utils/seedRoles";

const router = Router();

// GET /api/inventory/roles — list all roles with permissions
router.get("/roles", requireAuth, requirePermission("roles.view"), async (_req: AuthRequest, res) => {
  try {
    const roles = await prisma.roleConfig.findMany({
      orderBy: { createdAt: "asc" },
      include: { _count: { select: { users: true } } },
    });
    res.json({ roles: roles.map(r => ({ ...r, permissions: JSON.parse(r.permissions), userCount: r._count.users })) });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Failed to fetch roles" });
  }
});

// GET /api/inventory/roles/all-permissions — list available permission keys
router.get("/roles/all-permissions", requireAuth, requirePermission("roles.view"), (_req, res) => {
  res.json({ permissions: ALL_PERMISSIONS });
});

// PUT /api/inventory/roles/:id — update role permissions (owner only)
router.put("/roles/:id", requireAuth, requirePermission("roles.edit"), async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const { displayName, description, permissions } = req.body;

    const role = await prisma.roleConfig.findUnique({ where: { id } });
    if (!role) {
      res.status(404).json({ error: "Role not found" });
      return;
    }

    if (role.name === "owner") {
      res.status(400).json({ error: "Cannot modify owner role" });
      return;
    }

    if (role.name === "manager" && permissions && !permissions.includes("products.view")) {
      res.status(400).json({ error: "Manager must have products.view permission" });
      return;
    }

    const data: any = {};
    if (displayName) data.displayName = displayName;
    if (description !== undefined) data.description = description;
    if (permissions) data.permissions = JSON.stringify(permissions);

    const updated = await prisma.roleConfig.update({ where: { id }, data });
    res.json({ role: { ...updated, permissions: JSON.parse(updated.permissions) } });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Failed to update role" });
  }
});

// POST /api/inventory/roles/seed — upsert default roles (إنشاء الناقص + تحديث الموجود)
router.post("/roles/seed", requireAuth, requirePermission("roles.edit"), async (_req: AuthRequest, res) => {
  try {
    const { created, updated } = await upsertDefaultRoles(prisma);

    const roles = await prisma.roleConfig.findMany({ orderBy: { createdAt: "asc" } });
    res.json({ created, updated, roles: roles.map(r => ({ ...r, permissions: JSON.parse(r.permissions) })) });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Failed to seed roles" });
  }
});

export default router;
