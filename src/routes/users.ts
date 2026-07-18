import { Router } from "express";
import bcrypt from "bcryptjs";
import { prisma } from "../config/database";
import { requireAuth, requirePermission, AuthRequest } from "../middleware/auth";
import { DEFAULT_ROLES } from "../utils/permissions";

const router = Router();

// GET /api/inventory/users — list all users
router.get("/users", requireAuth, requirePermission("users.view"), async (_req: AuthRequest, res) => {
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true, email: true, firstName: true, lastName: true,
        title: true, department: true, position: true,
        role: true, roleId: true, createdAt: true,
        roleConfig: { select: { name: true, displayName: true } },
      },
      orderBy: { createdAt: "asc" },
    });
    res.json({ users });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Failed to fetch users" });
  }
});

// PATCH /api/inventory/users/:id/role — update user role
router.patch("/users/:id/role", requireAuth, requirePermission("users.manage"), async (req: AuthRequest, res) => {
  try {
    const { roleId } = req.body;
    const { id } = req.params;

    if (id === req.user?.userId) {
      res.status(400).json({ error: "Cannot change your own role" });
      return;
    }

    const roleConfig = await prisma.roleConfig.findUnique({ where: { id: roleId } });
    if (!roleConfig) {
      res.status(400).json({ error: "Invalid role" });
      return;
    }

    const user = await prisma.user.update({
      where: { id },
      data: { roleId, role: roleConfig.name },
      select: { id: true, email: true, firstName: true, lastName: true, role: true },
    });

    res.json({ user });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Failed to update role" });
  }
});

// DELETE /api/inventory/users/:id — delete a user
router.delete("/users/:id", requireAuth, requirePermission("users.manage"), async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    if (id === req.user?.userId) {
      res.status(400).json({ error: "Cannot delete yourself" });
      return;
    }
    await prisma.user.delete({ where: { id } });
    res.json({ message: "User deleted" });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Failed to delete user" });
  }
});

// POST /api/inventory/users/invite — create a new user (owner only)
router.post("/users/invite", requireAuth, requirePermission("users.manage"), async (req: AuthRequest, res) => {
  try {
    const { email, password, firstName, lastName, title, department, position, roleId } = req.body;
    if (!email || !password || !firstName || !lastName || !roleId) {
      res.status(400).json({ error: "Email, password, name, and role are required" });
      return;
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      res.status(409).json({ error: "Email already registered" });
      return;
    }

    const roleConfig = await prisma.roleConfig.findUnique({ where: { id: roleId } });
    if (!roleConfig) {
      res.status(400).json({ error: "Invalid role" });
      return;
    }

    const hashed = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: {
        email, password: hashed, firstName, lastName,
        title: title || null, department: department || null,
        position: position || null, role: roleConfig.name, roleId,
      },
      select: { id: true, email: true, firstName: true, lastName: true, role: true },
    });

    res.status(201).json({ user });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Failed to create user" });
  }
});

// GET /api/inventory/users/me — get current user with permissions
router.get("/users/me", requireAuth, async (req: AuthRequest, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      include: { roleConfig: true },
    });
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    let permissions: string[] = [];
    if (user.role === "owner") {
      permissions = Object.values(require("../utils/permissions").PERMISSIONS);
    } else if (user.roleConfig) {
      try { permissions = JSON.parse(user.roleConfig.permissions); } catch { permissions = []; }
    }

    res.json({
      user: {
        id: user.id, email: user.email,
        firstName: user.firstName, lastName: user.lastName,
        name: `${user.firstName} ${user.lastName}`,
        title: user.title, department: user.department, position: user.position,
        role: user.role, permissions,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Failed to fetch user" });
  }
});

export default router;
