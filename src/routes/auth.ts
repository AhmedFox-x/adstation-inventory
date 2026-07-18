import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { prisma } from "../config/database";
import { PERMISSIONS, ALL_PERMISSIONS } from "../utils/permissions";

const router = Router();

async function getUserPermissions(role: string, roleId: string | null): Promise<string[]> {
  if (role === "owner") return ALL_PERMISSIONS;
  if (!roleId) return [];
  const rc = await prisma.roleConfig.findUnique({ where: { id: roleId } });
  if (!rc) return [];
  try { return JSON.parse(rc.permissions); } catch { return []; }
}

function userPayload(user: any, permissions: string[]) {
  const fullName = `${user.firstName} ${user.lastName}`;
  return {
    id: user.id, email: user.email, name: fullName,
    firstName: user.firstName, lastName: user.lastName,
    title: user.title, department: user.department,
    position: user.position, role: user.role, roleId: user.roleId,
    permissions,
  };
}

// POST /api/inventory/auth/register
router.post("/register", async (req, res, next) => {
  try {
    const { email, password, firstName, lastName, title, department, position } = req.body;
    if (!email || !password || !firstName || !lastName) {
      res.status(400).json({ error: "Email, password, first name, and last name are required" });
      return;
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      res.status(409).json({ error: "Email already registered" });
      return;
    }

    const userCount = await prisma.user.count();
    const isFirstUser = userCount === 0;

    let roleName = "viewer";
    let roleId: string | null = null;

    if (isFirstUser) {
      const ownerRole = await prisma.roleConfig.findUnique({ where: { name: "owner" } });
      if (ownerRole) {
        roleName = "owner";
        roleId = ownerRole.id;
      }
    } else {
      const defaultRole = await prisma.roleConfig.findUnique({ where: { name: "viewer" } });
      if (defaultRole) {
        roleId = defaultRole.id;
      }
    }

    const hashed = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: {
        email, password: hashed, firstName, lastName,
        title: title || null, department: department || null,
        position: position || null, role: roleName, roleId,
      },
    });

    const permissions = await getUserPermissions(roleName, roleId);
    const token = jwt.sign(
      { userId: user.id, email: user.email, name: `${firstName} ${lastName}`, role: roleName },
      process.env.JWT_SECRET!,
      { expiresIn: "24h" }
    );

    res.status(201).json({ token, user: userPayload(user, permissions) });
  } catch (err) {
    next(err);
  }
});

// POST /api/inventory/auth/login
router.post("/login", async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      res.status(400).json({ error: "Email and password are required" });
      return;
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }

    const permissions = await getUserPermissions(user.role, user.roleId);
    const token = jwt.sign(
      { userId: user.id, email: user.email, name: `${user.firstName} ${user.lastName}`, role: user.role },
      process.env.JWT_SECRET!,
      { expiresIn: "24h" }
    );

    res.json({ token, user: userPayload(user, permissions) });
  } catch (err) {
    next(err);
  }
});

// GET /api/inventory/auth/me
router.get("/me", async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      res.status(401).json({ error: "No token" });
      return;
    }

    const decoded = jwt.verify(header.slice(7), process.env.JWT_SECRET!) as any;
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: { id: true, email: true, firstName: true, lastName: true, title: true, department: true, position: true, role: true, roleId: true },
    });

    if (!user) {
      res.status(401).json({ error: "User not found" });
      return;
    }

    const permissions = await getUserPermissions(user.role, user.roleId);
    res.json({ user: userPayload(user, permissions) });
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
});

export default router;
