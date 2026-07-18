import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { prisma } from "../config/database";

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

    if (req.user.role === "owner") {
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
