/**
 * settings.ts — System Settings & Feature Flags API
 *
 * GET    /api/inventory/settings          — returns all settings
 * GET    /api/inventory/settings/features — returns feature flags only
 * PUT    /api/inventory/settings          — bulk update settings (owner only)
 * PUT    /api/inventory/settings/features — update feature flags (owner only)
 */

import { Router } from "express";
import { prisma } from "../config/database";
import { requireAuth, requirePermission, AuthRequest } from "../middleware/auth";

const router = Router();

// Default feature flags — seeded on first run
const DEFAULT_FEATURES: Record<string, string> = {
  "feature.withdraw": "true",
  "feature.supply": "true",
  "feature.aiScan": "true",
  "feature.barcodeScan": "true",
  "feature.showroom": "true",
  "feature.catalogStudio": "true",
  "feature.reservations": "true",
  "feature.reorderCenter": "true",
  "feature.returns": "true",
  "feature.packDispatch": "true",
  "feature.uom": "true",
  "feature.cycleCount": "true",
  "feature.bundles": "true",
  "feature.serialBatch": "true",
  "feature.priceLists": "true",
  "feature.alerts": "true",
  "feature.anomalies": "true",
  "feature.importExport": "true",
  "feature.qrPrint": "true",
};

// GET /api/inventory/settings — all settings
router.get("/settings", requireAuth, requirePermission("settings.view"), async (req, res, next) => {
  try {
    const rows = await prisma.systemSettings.findMany({ orderBy: { key: "asc" } });
    const settings: Record<string, string> = {};
    for (const r of rows) settings[r.key] = r.value;
    res.json({ settings });
  } catch (err) { next(err); }
});

// GET /api/inventory/settings/features — feature flags only
router.get("/settings/features", requireAuth, requirePermission("settings.view"), async (req, res, next) => {
  try {
    const rows = await prisma.systemSettings.findMany({
      where: { key: { startsWith: "feature." } },
      orderBy: { key: "asc" },
    });
    const features: Record<string, boolean> = {};
    for (const r of rows) features[r.key] = r.value === "true";
    // Ensure defaults exist
    for (const [key, val] of Object.entries(DEFAULT_FEATURES)) {
      if (!(key in features)) features[key] = val === "true";
    }
    res.json({ features });
  } catch (err) { next(err); }
});

// PUT /api/inventory/settings — bulk update settings
router.put("/settings", requireAuth, requirePermission("settings.manage"), async (req: AuthRequest, res, next) => {
  try {
    const { settings } = req.body;
    if (!settings || typeof settings !== "object") {
      res.status(400).json({ error: "settings object is required" });
      return;
    }
    for (const [key, value] of Object.entries(settings)) {
      if (typeof value !== "string") continue;
      await prisma.systemSettings.upsert({
        where: { key },
        create: { key, value },
        update: { value },
      });
    }
    res.json({ message: "تم تحديث الإعدادات", updated: Object.keys(settings).length });
  } catch (err) { next(err); }
});

// PUT /api/inventory/settings/features — update feature flags
router.put("/settings/features", requireAuth, requirePermission("settings.manage"), async (req: AuthRequest, res, next) => {
  try {
    const { features } = req.body;
    if (!features || typeof features !== "object") {
      res.status(400).json({ error: "features object is required" });
      return;
    }
    for (const [key, enabled] of Object.entries(features)) {
      if (!key.startsWith("feature.")) continue;
      const value = enabled === true ? "true" : "false";
      await prisma.systemSettings.upsert({
        where: { key },
        create: { key, value },
        update: { value },
      });
    }
    res.json({ message: "تم تحديث الميزات", updated: Object.keys(features).length });
  } catch (err) { next(err); }
});

export default router;
