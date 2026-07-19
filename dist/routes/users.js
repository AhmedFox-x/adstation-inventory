"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const database_1 = require("../config/database");
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
// GET /api/inventory/users — list all users
router.get("/users", auth_1.requireAuth, (0, auth_1.requirePermission)("users.view"), async (_req, res) => {
    try {
        const users = await database_1.prisma.user.findMany({
            select: {
                id: true, email: true, firstName: true, lastName: true,
                title: true, department: true, position: true,
                role: true, roleId: true, createdAt: true,
                roleConfig: { select: { name: true, displayName: true } },
            },
            orderBy: { createdAt: "asc" },
        });
        res.json({ users });
    }
    catch (err) {
        res.status(500).json({ error: err?.message || "Failed to fetch users" });
    }
});
// PATCH /api/inventory/users/:id/role — update user role
router.patch("/users/:id/role", auth_1.requireAuth, (0, auth_1.requirePermission)("users.manage"), async (req, res) => {
    try {
        const { roleId } = req.body;
        const { id } = req.params;
        if (id === req.user?.userId) {
            res.status(400).json({ error: "Cannot change your own role" });
            return;
        }
        const roleConfig = await database_1.prisma.roleConfig.findUnique({ where: { id: roleId } });
        if (!roleConfig) {
            res.status(400).json({ error: "Invalid role" });
            return;
        }
        const user = await database_1.prisma.user.update({
            where: { id },
            data: { roleId, role: roleConfig.name },
            select: { id: true, email: true, firstName: true, lastName: true, role: true },
        });
        res.json({ user });
    }
    catch (err) {
        res.status(500).json({ error: err?.message || "Failed to update role" });
    }
});
// DELETE /api/inventory/users/:id — delete a user
router.delete("/users/:id", auth_1.requireAuth, (0, auth_1.requirePermission)("users.manage"), async (req, res) => {
    try {
        const { id } = req.params;
        if (id === req.user?.userId) {
            res.status(400).json({ error: "Cannot delete yourself" });
            return;
        }
        await database_1.prisma.user.delete({ where: { id } });
        res.json({ message: "User deleted" });
    }
    catch (err) {
        res.status(500).json({ error: err?.message || "Failed to delete user" });
    }
});
// POST /api/inventory/users/invite — create a new user (owner only)
router.post("/users/invite", auth_1.requireAuth, (0, auth_1.requirePermission)("users.manage"), async (req, res) => {
    try {
        const { email, password, firstName, lastName, title, department, position, roleId } = req.body;
        if (!email || !password || !firstName || !lastName || !roleId) {
            res.status(400).json({ error: "Email, password, name, and role are required" });
            return;
        }
        const existing = await database_1.prisma.user.findUnique({ where: { email } });
        if (existing) {
            res.status(409).json({ error: "Email already registered" });
            return;
        }
        const roleConfig = await database_1.prisma.roleConfig.findUnique({ where: { id: roleId } });
        if (!roleConfig) {
            res.status(400).json({ error: "Invalid role" });
            return;
        }
        const hashed = await bcryptjs_1.default.hash(password, 10);
        const user = await database_1.prisma.user.create({
            data: {
                email, password: hashed, firstName, lastName,
                title: title || null, department: department || null,
                position: position || null, role: roleConfig.name, roleId,
            },
            select: { id: true, email: true, firstName: true, lastName: true, role: true },
        });
        res.status(201).json({ user });
    }
    catch (err) {
        res.status(500).json({ error: err?.message || "Failed to create user" });
    }
});
// GET /api/inventory/users/me — get current user with permissions
router.get("/users/me", auth_1.requireAuth, async (req, res) => {
    try {
        const user = await database_1.prisma.user.findUnique({
            where: { id: req.user.userId },
            include: { roleConfig: true },
        });
        if (!user) {
            res.status(404).json({ error: "User not found" });
            return;
        }
        let permissions = [];
        if (user.role === "owner") {
            permissions = Object.values(require("../utils/permissions").PERMISSIONS);
        }
        else if (user.roleConfig) {
            try {
                permissions = JSON.parse(user.roleConfig.permissions);
            }
            catch {
                permissions = [];
            }
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
    }
    catch (err) {
        res.status(500).json({ error: err?.message || "Failed to fetch user" });
    }
});
exports.default = router;
//# sourceMappingURL=users.js.map