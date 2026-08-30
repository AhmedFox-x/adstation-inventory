import { Router } from "express";
import { prisma } from "../config/database";
import { AuthRequest, requireAuth, requirePermission } from "../middleware/auth";
import { PERMISSIONS } from "../utils/permissions";
import { runAnomalyDetection, summarizeAnomalies, ANOMALY_THRESHOLDS } from "../services/anomalyService";

const router = Router();

// GET /anomalies/summary — عدّادات الحالات الشاذة (open/reviewing/resolved/bySeverity)
router.get("/anomalies/summary", requireAuth, requirePermission(PERMISSIONS.ANOMALIES_VIEW), async (_req, res, next) => {
  try {
    res.json(await summarizeAnomalies(prisma));
  } catch (err) {
    next(err);
  }
});

// GET /anomalies — قائمة الحالات الشاذة
// ?status=open|reviewing|resolved&severity=&code=&page=&limit=
router.get("/anomalies", requireAuth, requirePermission(PERMISSIONS.ANOMALIES_VIEW), async (req, res, next) => {
  try {
    const { status, severity, code, page = "1", limit = "50" } = req.query as Record<string, string>;
    const where: any = {};
    if (status && status !== "all") where.status = status;
    if (severity && severity !== "all") where.severity = severity;
    if (code && code !== "all") where.code = code;

    const pageNum = Math.max(Number(page) || 1, 1);
    const limitNum = Math.min(Math.max(Number(limit) || 50, 1), 100);
    const [anomalies, total] = await Promise.all([
      prisma.anomaly.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (pageNum - 1) * limitNum,
        take: limitNum,
      }),
      prisma.anomaly.count({ where }),
    ]);
    res.json({
      anomalies: anomalies.map((a) => ({ ...a, details: a.details as any })),
      total,
      page: pageNum,
      pages: Math.ceil(total / limitNum),
      thresholds: ANOMALY_THRESHOLDS,
    });
  } catch (err) {
    next(err);
  }
});

// POST /anomalies/run — تشغيل قواعد الكشف السبع يدويًا
router.post("/anomalies/run", requireAuth, requirePermission(PERMISSIONS.ANOMALIES_RUN), async (_req, res, next) => {
  try {
    const result = await runAnomalyDetection(prisma);
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

// GET /anomalies/:id — تفاصيل حالة شاذة (بما فيها المصادر المرتبطة)
router.get("/anomalies/:id", requireAuth, requirePermission(PERMISSIONS.ANOMALIES_VIEW), async (req, res, next) => {
  try {
    const anomaly = await prisma.anomaly.findUnique({ where: { id: req.params.id } });
    if (!anomaly) {
      res.status(404).json({ error: "Anomaly not found" });
      return;
    }
    res.json({ anomaly: { ...anomaly, details: anomaly.details as any } });
  } catch (err) {
    next(err);
  }
});

// PATCH /anomalies/:id — resolve/reopen (اعتماد نهائي للمالك)
router.patch("/anomalies/:id", requireAuth, requirePermission(PERMISSIONS.ANOMALIES_RESOLVE), async (req: AuthRequest, res, next) => {
  try {
    const { action, note } = req.body as any;
    const existing = await prisma.anomaly.findUnique({ where: { id: req.params.id } });
    if (!existing) {
      res.status(404).json({ error: "Anomaly not found" });
      return;
    }
    if (!action || !["resolve", "reopen", "reviewing"].includes(action)) {
      res.status(400).json({ error: "action must be resolve|reviewing|reopen" });
      return;
    }
    const sameNote = note?.trim() || existing.resolutionNote;
    const data: any =
      action === "reopen"
        ? { status: "open", resolvedAt: null, resolvedBy: null, resolutionNote: null }
        : action === "reviewing"
          ? { status: "reviewing", resolvedAt: null, resolvedBy: null, resolutionNote: null }
          : { status: "resolved", resolvedBy: req.user?.userId || null, resolvedAt: new Date(), resolutionNote: sameNote };
    const updated = await prisma.anomaly.update({ where: { id: existing.id }, data });
    res.json({ anomaly: updated });
  } catch (err) {
    next(err);
  }
});

export default router;