import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";

import authRouter from "./routes/auth";
import productsRouter from "./routes/products";
import permitsRouter from "./routes/permits";
import logRouter from "./routes/log";
import scanRouter from "./routes/scan";
import usersRouter from "./routes/users";
import rolesRouter from "./routes/roles";

import { errorHandler } from "./middleware/errorHandler";
import { initKeyManager } from "./utils/keyManager";
import { DEFAULT_ROLES } from "./utils/permissions";
import { prisma } from "./config/database";

// ─── Init Key Manager ────────────────────────────────────────────────────────
const apiKeys = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || "";
initKeyManager(apiKeys);

// ─── Auto-seed default roles ─────────────────────────────────────────────────
async function seedRoles() {
  try {
    for (const [name, config] of Object.entries(DEFAULT_ROLES)) {
      const exists = await prisma.roleConfig.findUnique({ where: { name } });
      if (!exists) {
        await prisma.roleConfig.create({
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
    const firstUser = await prisma.user.findFirst({ where: { roleId: null } });
    if (firstUser) {
      const ownerRole = await prisma.roleConfig.findUnique({ where: { name: "owner" } });
      if (ownerRole) {
        await prisma.user.update({ where: { id: firstUser.id }, data: { roleId: ownerRole.id, role: "owner" } });
        console.log(`  👑 Assigned owner role to ${firstUser.email}`);
      }
    }
  } catch (e: any) {
    console.log(`  ⚠️  Role seeding skipped: ${e?.message}`);
  }
}

const app = express();

// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use(
  cors({
    origin: [
      process.env.FRONTEND_URL || "http://localhost:5174",
      "http://localhost:5174",
      "https://localhost:4443",
      `https://localhost:${Number(process.env.HTTPS_PORT) || 4443}`,
    ],
    credentials: true,
  })
);

// ─── Body parsing ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true }));

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "inventory", timestamp: new Date().toISOString() });
});

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use("/api/inventory/auth", authRouter);
app.use("/api/inventory", productsRouter);
app.use("/api/inventory", permitsRouter);
app.use("/api/inventory", logRouter);
app.use("/api/inventory", scanRouter);
app.use("/api/inventory", usersRouter);
app.use("/api/inventory", rolesRouter);

// ─── Key Manager Status ──────────────────────────────────────────────────────
import { getStatus, getKeyCount } from "./utils/keyManager";
import { requireAuth } from "./middleware/auth";

app.get("/api/inventory/keys/status", requireAuth, (_req, res) => {
  res.json({ keys: getStatus(), totalKeys: getKeyCount() });
});

// ─── Static files (Production) ───────────────────────────────────────────────
const distPath = process.env.NODE_ENV === "production"
  ? path.resolve(__dirname, "../public")
  : path.resolve(__dirname, "../../inventory-frontend/dist");
app.use(express.static(distPath));

// ─── Product images ──────────────────────────────────────────────────────────
const uploadsPath = path.resolve(__dirname, "../public/uploads");
app.use("/uploads", express.static(uploadsPath));

// SPA fallback — non-API routes return index.html
app.get("*", (req, res) => {
  if (!req.path.startsWith("/api/")) {
    res.sendFile(path.join(distPath, "index.html"));
  } else {
    if (!res.headersSent) {
      res.status(404).json({ error: "Not found" });
    }
  }
});

// ─── Error handlers ───────────────────────────────────────────────────────────
app.use(errorHandler);

// ─── Start ────────────────────────────────────────────────────────────────────
import https from "https";
import fs from "fs";

const PORT = Number(process.env.PORT) || 4001;
const HTTPS_PORT = Number(process.env.HTTPS_PORT) || 4443;

const pfxPath = path.resolve(__dirname, "../certs/cert.pfx");
const certDir = path.resolve(__dirname, "../certs");
const certPemPath = path.join(certDir, "cert.pem");
const keyPemPath = path.join(certDir, "key.pem");

function startServer() {
  seedRoles().then(() => {
    // HTTP always runs
    app.listen(PORT, () => {
      console.log(`\n📦  AD Station Inventory API running on http://localhost:${PORT}`);
      console.log(`   Environment: ${process.env.NODE_ENV || "development"}\n`);
    });

    // HTTPS — try PFX first, then PEM
    if (fs.existsSync(pfxPath)) {
      const pfx = fs.readFileSync(pfxPath);
      https.createServer({ pfx, passphrase: process.env.CERT_PASSPHRASE || "adstation123" }, app).listen(HTTPS_PORT, () => {
        console.log(`🔒  HTTPS running on https://localhost:${HTTPS_PORT}`);
      });
    } else if (fs.existsSync(certPemPath) && fs.existsSync(keyPemPath)) {
      https.createServer({
        cert: fs.readFileSync(certPemPath),
        key: fs.readFileSync(keyPemPath),
      }, app).listen(HTTPS_PORT, () => {
        console.log(`🔒  HTTPS running on https://localhost:${HTTPS_PORT}`);
      });
    } else {
      console.log(`⚠️  No SSL cert found — HTTPS disabled. Run generate-cert.cjs or place cert.pem + key.pem in certs/`);
    }
  });
}

startServer();

export default app;
