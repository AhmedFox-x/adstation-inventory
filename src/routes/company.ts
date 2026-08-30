/**
 * company.ts — Company settings API
 *
 * GET  /api/inventory/company/settings  — returns current company name
 * PUT  /api/inventory/company/settings  — updates company name (Owner/Admin only)
 */

import { Router } from "express";
import { prisma } from "../config/database";
import { requireAuth, requirePermission, AuthRequest } from "../middleware/auth";
import { getCompanyName, setCompanyName } from "../services/companyService";

const router = Router();

router.get("/company/settings", requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const name = await getCompanyName(prisma);
    res.json({ companyName: name });
  } catch (err) {
    next(err);
  }
});

router.put("/company/settings", requireAuth, requirePermission("users.manage"), async (req: AuthRequest, res, next) => {
  try {
    const { companyName } = req.body;
    if (!companyName || typeof companyName !== "string" || companyName.trim().length === 0) {
      res.status(400).json({ error: "companyName is required" });
      return;
    }
    await setCompanyName(prisma, companyName);
    res.json({ companyName: companyName.trim(), message: "تم تحديث اسم الشركة بنجاح" });
  } catch (err) {
    next(err);
  }
});

export default router;
