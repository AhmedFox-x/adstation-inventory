import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";

import authRouter from "./routes/auth";
import productsRouter from "./routes/products";
import permitsRouter from "./routes/permits";
import logRouter from "./routes/log";
import scanRouter from "./routes/scan";
import stocktakeRouter from "./routes/stocktake";
import usersRouter from "./routes/users";
import rolesRouter from "./routes/roles";
import barcodeRouter from "./routes/barcode";
import suppliersRouter from "./routes/suppliers";
import purchaseOrdersRouter from "./routes/purchase-orders";
import clientsRouter from "./routes/clients";
import csvRouter from "./routes/csv";
import reportsRouter from "./routes/reports";
import reservationsRouter from "./routes/reservations";
import salesOrdersRouter from "./routes/sales-orders";
import returnsRouter from "./routes/returns";
import notificationsRouter from "./routes/notifications";

import { errorHandler } from "./middleware/errorHandler";
import { initKeyManager } from "./utils/keyManager";
import { DEFAULT_ROLES } from "./utils/permissions";
import { prisma } from "./config/database";
import { seedBarcodes } from "./utils/barcode";
import { apiLimiter, authLimiter } from "./middleware/rateLimiter";
import { initSentry, captureException } from "./utils/sentry";

// ─── Init Sentry ──────────────────────────────────────────────────────────────
initSentry();

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
      } else {
        const currentPerms = JSON.parse(exists.permissions);
        const desiredPerms = config.permissions;
        const needsUpdate =
          currentPerms.length !== desiredPerms.length ||
          !desiredPerms.every((p: string) => currentPerms.includes(p));
        if (needsUpdate) {
          await prisma.roleConfig.update({
            where: { name },
            data: { permissions: JSON.stringify(desiredPerms) },
          });
          console.log(`  🔄 Updated role: ${name} (${currentPerms.length} → ${desiredPerms.length} permissions)`);
        }
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

// ─── Trust proxy (Railway, Heroku, etc.) ─────────────────────────────────────
app.set("trust proxy", 1);

// ─── Sentry Request/Tracing Middleware ────────────────────────────────────────
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
app.get("/health", async (_req, res) => {
  try {
    const productCount = await prisma.product.count();
    const userCount = await prisma.user.count();
    res.json({ 
      status: "ok", 
      service: "inventory", 
      timestamp: new Date().toISOString(),
      db: { products: productCount, users: userCount }
    });
  } catch (err: any) {
    res.json({ 
      status: "error", 
      service: "inventory", 
      timestamp: new Date().toISOString(),
      db: { error: err?.message || "Connection failed" }
    });
  }
});

// ─── Routes (with rate limiting) ─────────────────────────────────────────────
app.use("/api/inventory/auth", authLimiter, authRouter);
app.use("/api/inventory", apiLimiter);
app.use("/api/inventory", productsRouter);
app.use("/api/inventory", permitsRouter);
app.use("/api/inventory", logRouter);
app.use("/api/inventory", scanRouter);
app.use("/api/inventory", stocktakeRouter);
app.use("/api/inventory", usersRouter);
app.use("/api/inventory", rolesRouter);
app.use("/api/inventory", barcodeRouter);
app.use("/api/inventory", suppliersRouter);
app.use("/api/inventory", purchaseOrdersRouter);
app.use("/api/inventory", clientsRouter);
app.use("/api/inventory", csvRouter);
app.use("/api/inventory", reportsRouter);
app.use("/api/inventory", reservationsRouter);
app.use("/api/inventory", salesOrdersRouter);
app.use("/api/inventory", returnsRouter);
app.use("/api/inventory", notificationsRouter);

// ─── Key Manager Status ──────────────────────────────────────────────────────
import { getStatus, getKeyCount } from "./utils/keyManager";
import { requireAuth } from "./middleware/auth";
import { runManualAlertCheck } from "./utils/alerts";

app.get("/api/inventory/keys/status", requireAuth, (_req, res) => {
  res.json({ keys: getStatus(), totalKeys: getKeyCount() });
});

app.post("/api/inventory/alerts/check", requireAuth, async (_req, res) => {
  try {
    const result = await runManualAlertCheck(prisma);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: "Alert check failed" });
  }
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
  seedRoles().then(() => seedBarcodes()).then(() => {
    app.listen(PORT, () => {
      console.log(`\n📦  AD Station Inventory API running on http://localhost:${PORT}`);
      console.log(`   Environment: ${process.env.NODE_ENV || "development"}\n`);
    });

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
