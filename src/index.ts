import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";

import authRouter from "./routes/auth";
import productsRouter from "./routes/products";
import permitsRouter from "./routes/permits";
import logRouter from "./routes/log";
import scanRouter from "./routes/scan";

import { errorHandler } from "./middleware/errorHandler";
import { initKeyManager } from "./utils/keyManager";

// ─── Init Key Manager ────────────────────────────────────────────────────────
const apiKeys = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || "";
initKeyManager(apiKeys);

const app = express();

// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use(
  cors({
    origin: [
      process.env.FRONTEND_URL || "http://localhost:5174",
      "http://localhost:5174",
      "http://localhost:4001",
      "https://localhost:4443",
      `https://localhost:${Number(process.env.HTTPS_PORT) || 4443}`,
    ],
    credentials: true,
  })
);

// ─── Body parsing ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: "10mb" }));
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
  // HTTP only — Railway handles HTTPS termination
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`\n📦  AD Station Inventory API running on http://0.0.0.0:${PORT}`);
    console.log(`   Environment: ${process.env.NODE_ENV || "development"}\n`);
  });

  // HTTPS — only for local dev (skip on Railway)
  if (process.env.NODE_ENV !== "production") {
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
      console.log(`⚠️  No SSL cert found — HTTPS disabled.`);
    }
  }
}

startServer();

export default app;
