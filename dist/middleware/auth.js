"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireAuth = requireAuth;
exports.requirePermission = requirePermission;
exports.optionalAuth = optionalAuth;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const database_1 = require("../config/database");
function requireAuth(req, res, next) {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
        res.status(401).json({ error: "Authentication required" });
        return;
    }
    const token = header.slice(7);
    try {
        const decoded = jsonwebtoken_1.default.verify(token, process.env.JWT_SECRET);
        req.user = decoded;
        next();
    }
    catch {
        res.status(401).json({ error: "Invalid or expired token" });
    }
}
function requirePermission(...perms) {
    return async (req, res, next) => {
        if (!req.user) {
            res.status(401).json({ error: "Authentication required" });
            return;
        }
        if (req.user.role === "owner") {
            next();
            return;
        }
        const user = await database_1.prisma.user.findUnique({
            where: { id: req.user.userId },
            include: { roleConfig: true },
        });
        if (!user || !user.roleConfig) {
            res.status(403).json({ error: "No role assigned" });
            return;
        }
        let permissions;
        try {
            permissions = JSON.parse(user.roleConfig.permissions);
        }
        catch {
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
function optionalAuth(req, _res, next) {
    const header = req.headers.authorization;
    if (header && header.startsWith("Bearer ")) {
        try {
            const decoded = jsonwebtoken_1.default.verify(header.slice(7), process.env.JWT_SECRET);
            req.user = decoded;
        }
        catch {
            // ignore invalid token
        }
    }
    next();
}
//# sourceMappingURL=auth.js.map