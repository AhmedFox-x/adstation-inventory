"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const path_1 = __importDefault(require("path"));
const auth_1 = __importDefault(require("./routes/auth"));
const products_1 = __importDefault(require("./routes/products"));
const permits_1 = __importDefault(require("./routes/permits"));
const log_1 = __importDefault(require("./routes/log"));
const scan_1 = __importDefault(require("./routes/scan"));
const users_1 = __importDefault(require("./routes/users"));
const roles_1 = __importDefault(require("./routes/roles"));
const errorHandler_1 = require("./middleware/errorHandler");
const keyManager_1 = require("./utils/keyManager");
const permissions_1 = require("./utils/permissions");
const database_1 = require("./config/database");
// ─── Init Key Manager ────────────────────────────────────────────────────────
const apiKeys = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || "";
(0, keyManager_1.initKeyManager)(apiKeys);
// ─── Auto-seed default roles ─────────────────────────────────────────────────
async function seedRoles() {
    try {
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
                console.log(`  ✅ Created role: ${name}`);
            }
        }
        const firstUser = await database_1.prisma.user.findFirst({ where: { roleId: null } });
        if (firstUser) {
            const ownerRole = await database_1.prisma.roleConfig.findUnique({ where: { name: "owner" } });
            if (ownerRole) {
                await database_1.prisma.user.update({ where: { id: firstUser.id }, data: { roleId: ownerRole.id, role: "owner" } });
                console.log(`  👑 Assigned owner role to ${firstUser.email}`);
            }
        }
    }
    catch (e) {
        console.log(`  ⚠️  Role seeding skipped: ${e?.message}`);
    }
}
const app = (0, express_1.default)();
// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use((0, cors_1.default)({
    origin: [
        process.env.FRONTEND_URL || "http://localhost:5174",
        "http://localhost:5174",
        "https://localhost:4443",
        `https://localhost:${Number(process.env.HTTPS_PORT) || 4443}`,
    ],
    credentials: true,
}));
// ─── Body parsing ─────────────────────────────────────────────────────────────
app.use(express_1.default.json({ limit: "10mb" }));
app.use(express_1.default.urlencoded({ extended: true }));
// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "inventory", timestamp: new Date().toISOString() });
});
// ─── Routes ───────────────────────────────────────────────────────────────────
app.use("/api/inventory/auth", auth_1.default);
app.use("/api/inventory", products_1.default);
app.use("/api/inventory", permits_1.default);
app.use("/api/inventory", log_1.default);
app.use("/api/inventory", scan_1.default);
app.use("/api/inventory", users_1.default);
app.use("/api/inventory", roles_1.default);
// ─── Key Manager Status ──────────────────────────────────────────────────────
const keyManager_2 = require("./utils/keyManager");
const auth_2 = require("./middleware/auth");
app.get("/api/inventory/keys/status", auth_2.requireAuth, (_req, res) => {
    res.json({ keys: (0, keyManager_2.getStatus)(), totalKeys: (0, keyManager_2.getKeyCount)() });
});
// ─── Static files (Production) ───────────────────────────────────────────────
const distPath = path_1.default.resolve(__dirname, "../../inventory-frontend/dist");
app.use(express_1.default.static(distPath));
// SPA fallback — non-API routes return index.html
app.get("*", (req, res) => {
    if (!req.path.startsWith("/api/")) {
        res.sendFile(path_1.default.join(distPath, "index.html"));
    }
    else {
        if (!res.headersSent) {
            res.status(404).json({ error: "Not found" });
        }
    }
});
// ─── Error handlers ───────────────────────────────────────────────────────────
app.use(errorHandler_1.errorHandler);
// ─── Start ────────────────────────────────────────────────────────────────────
const https_1 = __importDefault(require("https"));
const fs_1 = __importDefault(require("fs"));
const PORT = Number(process.env.PORT) || 4001;
const HTTPS_PORT = Number(process.env.HTTPS_PORT) || 4443;
const pfxPath = path_1.default.resolve(__dirname, "../certs/cert.pfx");
const certDir = path_1.default.resolve(__dirname, "../certs");
const certPemPath = path_1.default.join(certDir, "cert.pem");
const keyPemPath = path_1.default.join(certDir, "key.pem");
function startServer() {
    seedRoles().then(() => {
        // HTTP always runs
        app.listen(PORT, () => {
            console.log(`\n📦  AD Station Inventory API running on http://localhost:${PORT}`);
            console.log(`   Environment: ${process.env.NODE_ENV || "development"}\n`);
        });
        // HTTPS — try PFX first, then PEM
        if (fs_1.default.existsSync(pfxPath)) {
            const pfx = fs_1.default.readFileSync(pfxPath);
            https_1.default.createServer({ pfx, passphrase: process.env.CERT_PASSPHRASE || "adstation123" }, app).listen(HTTPS_PORT, () => {
                console.log(`🔒  HTTPS running on https://localhost:${HTTPS_PORT}`);
            });
        }
        else if (fs_1.default.existsSync(certPemPath) && fs_1.default.existsSync(keyPemPath)) {
            https_1.default.createServer({
                cert: fs_1.default.readFileSync(certPemPath),
                key: fs_1.default.readFileSync(keyPemPath),
            }, app).listen(HTTPS_PORT, () => {
                console.log(`🔒  HTTPS running on https://localhost:${HTTPS_PORT}`);
            });
        }
        else {
            console.log(`⚠️  No SSL cert found — HTTPS disabled. Run generate-cert.cjs or place cert.pem + key.pem in certs/`);
        }
    });
}
startServer();
exports.default = app;
//# sourceMappingURL=index.js.map