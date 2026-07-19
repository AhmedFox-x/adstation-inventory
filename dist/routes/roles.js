"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const database_1 = require("../config/database");
const auth_1 = require("../middleware/auth");
const permissions_1 = require("../utils/permissions");
const router = (0, express_1.Router)();
// GET /api/inventory/roles — list all roles with permissions
router.get("/roles", auth_1.requireAuth, (0, auth_1.requirePermission)("roles.view"), async (_req, res) => {
    try {
        const roles = await database_1.prisma.roleConfig.findMany({
            orderBy: { createdAt: "asc" },
            include: { _count: { select: { users: true } } },
        });
        res.json({ roles: roles.map(r => ({ ...r, permissions: JSON.parse(r.permissions), userCount: r._count.users })) });
    }
    catch (err) {
        res.status(500).json({ error: err?.message || "Failed to fetch roles" });
    }
});
// GET /api/inventory/roles/all-permissions — list available permission keys
router.get("/roles/all-permissions", auth_1.requireAuth, (0, auth_1.requirePermission)("roles.view"), (_req, res) => {
    res.json({ permissions: permissions_1.ALL_PERMISSIONS });
});
// PUT /api/inventory/roles/:id — update role permissions (owner only)
router.put("/roles/:id", auth_1.requireAuth, (0, auth_1.requirePermission)("roles.edit"), async (req, res) => {
    try {
        const { id } = req.params;
        const { displayName, description, permissions } = req.body;
        const role = await database_1.prisma.roleConfig.findUnique({ where: { id } });
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
        const data = {};
        if (displayName)
            data.displayName = displayName;
        if (description !== undefined)
            data.description = description;
        if (permissions)
            data.permissions = JSON.stringify(permissions);
        const updated = await database_1.prisma.roleConfig.update({ where: { id }, data });
        res.json({ role: { ...updated, permissions: JSON.parse(updated.permissions) } });
    }
    catch (err) {
        res.status(500).json({ error: err?.message || "Failed to update role" });
    }
});
// POST /api/inventory/roles/seed — create default roles if missing
router.post("/roles/seed", auth_1.requireAuth, (0, auth_1.requirePermission)("roles.edit"), async (_req, res) => {
    try {
        const created = [];
        for (const [name, config] of Object.entries(permissions_1.DEFAULT_ROLES)) {
            const exists = await database_1.prisma.roleConfig.findUnique({ where: { name } });
            if (!exists) {
                await database_1.prisma.roleConfig.create({
                    data: {
                        name,
                        displayName: config.displayName,
                        description: config.description,
                        permissions: JSON.stringify(config.permissions),
                    },
                });
                created.push(name);
            }
        }
        const roles = await database_1.prisma.roleConfig.findMany({ orderBy: { createdAt: "asc" } });
        res.json({ created, roles: roles.map(r => ({ ...r, permissions: JSON.parse(r.permissions) })) });
    }
    catch (err) {
        res.status(500).json({ error: err?.message || "Failed to seed roles" });
    }
});
exports.default = router;
//# sourceMappingURL=roles.js.map