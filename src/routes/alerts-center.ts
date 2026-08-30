import { Router } from "express";
import { prisma } from "../config/database";
import { AuthRequest, requireAuth, requirePermission } from "../middleware/auth";
import { PERMISSIONS } from "../utils/permissions";
import { runAlertsSweep, alertsSummary } from "../services/alertService";

const router = Router();

// GET /alerts/summary — ملخص العدّادات لصفحة مركز التنبيهات + بادج الجرس
router.get("/alerts/summary", requireAuth, requirePermission(PERMISSIONS.ALERTS_VIEW), async (req: AuthRequest, res, next) => {
  try {
    res.json(await alertsSummary(prisma));
  } catch (err) {
    next(err);
  }
});

// GET /alerts — تغذية مركز التنبيهات (إشعارات النظام + الشخصية)
// ?category=&severity=&status=active|resolved|snoozed&page=&limit=
router.get("/alerts", requireAuth, requirePermission(PERMISSIONS.ALERTS_VIEW), async (req: AuthRequest, res, next) => {
  try {
    const { category, severity, status = "active", page = "1", limit = "50" } = req.query as Record<string, string>;
    const where: any = {
      createdBySystem: true,
      deletedAt: null,
      OR: [{ userId: null }, { userId: req.user?.userId }],
    };
    if (category && category !== "all") where.category = category;
    if (severity && severity !== "all") where.severity = severity;

    if (status === "active") {
      where.resolvedAt = null;
      where.OR = [{ snoozedUntil: null }, { snoozedUntil: { lte: new Date() } }];
    } else if (status === "resolved") {
      where.resolvedAt = { not: null };
    } else if (status === "snoozed") {
      where.resolvedAt = null;
      where.snoozedUntil = { gt: new Date() };
    }

    const pageNum = Math.max(Number(page) || 1, 1);
    const limitNum = Math.min(Math.max(Number(limit) || 50, 1), 100);
    const [notifications, total] = await Promise.all([
      prisma.notification.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (pageNum - 1) * limitNum,
        take: limitNum,
      }),
      prisma.notification.count({ where }),
    ]);

    res.json({ notifications, total, page: pageNum, pages: Math.ceil(total / limitNum), filters: { category, severity, status } });
  } catch (err) {
    next(err);
  }
});

// POST /alerts/check — تشغيل فحص التنبيهات الكامل (سويب)
router.post("/alerts/check", requireAuth, requirePermission(PERMISSIONS.ALERTS_MANAGE), async (_req, res, next) => {
  try {
    const counts = await runAlertsSweep(prisma);
    res.json({ ok: true, counts });
  } catch (err) {
    next(err);
  }
});

// PATCH /alerts/:id/resolve — وضع تنبيه كمحلول (مضبوط النطاق)
router.patch("/alerts/:id/resolve", requireAuth, requirePermission(PERMISSIONS.ALERTS_MANAGE), async (req: AuthRequest, res, next) => {
  try {
    const n = await prisma.notification.findUnique({ where: { id: req.params.id } });
    if (!n) {
      res.status(404).json({ error: "Notification not found" });
      return;
    }
    const updated = await prisma.notification.update({
      where: { id: n.id },
      data: { resolvedAt: new Date(), resolvedBy: req.user?.userId || null, isRead: true, readAt: new Date() },
    });
    res.json({ notification: updated });
  } catch (err) {
    next(err);
  }
});

// PATCH /alerts/:id/snooze — إخفاء للفترة {until}
router.patch("/alerts/:id/snooze", requireAuth, requirePermission(PERMISSIONS.ALERTS_MANAGE), async (req: AuthRequest, res, next) => {
  try {
    const until = new Date((req.body as any)?.until);
    if (isNaN(until.getTime())) {
      res.status(400).json({ error: "until (ISO date) is required" });
      return;
    }
    const n = await prisma.notification.findUnique({ where: { id: req.params.id } });
    if (!n) {
      res.status(404).json({ error: "Notification not found" });
      return;
    }
    const updated = await prisma.notification.update({
      where: { id: n.id },
      data: { snoozedUntil: until, isRead: true, readAt: new Date() },
    });
    res.json({ notification: updated });
  } catch (err) {
    next(err);
  }
});

// GET /alerts/categories — فئات التنبيه (ثابتة، للواجهة)
router.get("/alerts/categories", requireAuth, requirePermission(PERMISSIONS.ALERTS_VIEW), (_req, res) => {
  res.json({
    categories: ["stock", "reorder", "pricing", "returns", "orders", "quarantine", "anomalies"],
  });
});

export default router;