import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { prisma } from "../config/database";
import { createError } from "./errorHandler";

export interface AuthRequest extends Request {
  user?: { userId: string; email: string; name?: string; role?: string; permissions?: string[] };
}

export function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const token = header.slice(7);
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as {
      userId: string;
      email: string;
      name?: string;
      role?: string;
    };
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

export function requirePermission(...perms: string[]) {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    // Emergency bypass — Disabled افتراضيًا. يُفعَّل فقط عند الطوارئ عبر env.
    const emergencyBypass = process.env.PERMISSION_EMERGENCY_BYPASS === "true";
    if (req.user.role === "owner" && emergencyBypass) {
      next();
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      include: { roleConfig: true },
    });

    if (!user || !user.roleConfig) {
      res.status(403).json({ error: "No role assigned" });
      return;
    }

    let permissions: string[];
    try {
      permissions = JSON.parse(user.roleConfig.permissions);
    } catch {
      res.status(403).json({ error: "Invalid role configuration" });
      return;
    }

    const hasAll = perms.every(p => permissions.includes(p));
    if (!hasAll) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }

    req.user.permissions = permissions;
    next();
  };
}

/**
 * Promise-based permission check for inline use inside route handlers.
 * Unlike requirePermission (Express middleware), it REJECTS on denial so an
 * `await assertPermission(...)` short-circuits the handler before any mutation.
 * Rejections are forwarded to the error handler by the route's try/catch.
 */
export async function assertPermission(req: AuthRequest, ...perms: string[]): Promise<void> {
  if (!req.user) {
    throw createError("Authentication required", 401);
  }

  const emergencyBypass = process.env.PERMISSION_EMERGENCY_BYPASS === "true";
  if (req.user.role === "owner" && emergencyBypass) {
    return;
  }

  const user = await prisma.user.findUnique({
    where: { id: req.user.userId },
    include: { roleConfig: true },
  });

  if (!user || !user.roleConfig) {
    throw createError("No role assigned", 403);
  }

  let permissions: string[];
  try {
    permissions = JSON.parse(user.roleConfig.permissions);
  } catch {
    throw createError("Invalid role configuration", 403);
  }

  const hasAll = perms.every(p => permissions.includes(p));
  if (!hasAll) {
    throw createError("Insufficient permissions", 403);
  }

  req.user.permissions = permissions;
}

export function optionalAuth(req: AuthRequest, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (header && header.startsWith("Bearer ")) {
    try {
      const decoded = jwt.verify(header.slice(7), process.env.JWT_SECRET!) as {
        userId: string;
        email: string;
        name?: string;
        role?: string;
      };
      req.user = decoded;
    } catch {
      // ignore invalid token
    }
  }
  next();
}
