"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const database_1 = require("../config/database");
const permissions_1 = require("../utils/permissions");
const router = (0, express_1.Router)();
async function getUserPermissions(role, roleId) {
    if (role === "owner")
        return permissions_1.ALL_PERMISSIONS;
    if (!roleId)
        return [];
    const rc = await database_1.prisma.roleConfig.findUnique({ where: { id: roleId } });
    if (!rc)
        return [];
    try {
        return JSON.parse(rc.permissions);
    }
    catch {
        return [];
    }
}
function userPayload(user, permissions) {
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
        const existing = await database_1.prisma.user.findUnique({ where: { email } });
        if (existing) {
            res.status(409).json({ error: "Email already registered" });
            return;
        }
        const userCount = await database_1.prisma.user.count();
        const isFirstUser = userCount === 0;
        let roleName = "viewer";
        let roleId = null;
        if (isFirstUser) {
            const ownerRole = await database_1.prisma.roleConfig.findUnique({ where: { name: "owner" } });
            if (ownerRole) {
                roleName = "owner";
                roleId = ownerRole.id;
            }
        }
        else {
            const defaultRole = await database_1.prisma.roleConfig.findUnique({ where: { name: "viewer" } });
            if (defaultRole) {
                roleId = defaultRole.id;
            }
        }
        const hashed = await bcryptjs_1.default.hash(password, 10);
        const user = await database_1.prisma.user.create({
            data: {
                email, password: hashed, firstName, lastName,
                title: title || null, department: department || null,
                position: position || null, role: roleName, roleId,
            },
        });
        const permissions = await getUserPermissions(roleName, roleId);
        const token = jsonwebtoken_1.default.sign({ userId: user.id, email: user.email, name: `${firstName} ${lastName}`, role: roleName }, process.env.JWT_SECRET, { expiresIn: "24h" });
        res.status(201).json({ token, user: userPayload(user, permissions) });
    }
    catch (err) {
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
        const user = await database_1.prisma.user.findUnique({ where: { email } });
        if (!user) {
            res.status(401).json({ error: "Invalid credentials" });
            return;
        }
        const valid = await bcryptjs_1.default.compare(password, user.password);
        if (!valid) {
            res.status(401).json({ error: "Invalid credentials" });
            return;
        }
        const permissions = await getUserPermissions(user.role, user.roleId);
        const token = jsonwebtoken_1.default.sign({ userId: user.id, email: user.email, name: `${user.firstName} ${user.lastName}`, role: user.role }, process.env.JWT_SECRET, { expiresIn: "24h" });
        res.json({ token, user: userPayload(user, permissions) });
    }
    catch (err) {
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
        const decoded = jsonwebtoken_1.default.verify(header.slice(7), process.env.JWT_SECRET);
        const user = await database_1.prisma.user.findUnique({
            where: { id: decoded.userId },
            select: { id: true, email: true, firstName: true, lastName: true, title: true, department: true, position: true, role: true, roleId: true },
        });
        if (!user) {
            res.status(401).json({ error: "User not found" });
            return;
        }
        const permissions = await getUserPermissions(user.role, user.roleId);
        res.json({ user: userPayload(user, permissions) });
    }
    catch {
        res.status(401).json({ error: "Invalid token" });
    }
});
exports.default = router;
//# sourceMappingURL=auth.js.map