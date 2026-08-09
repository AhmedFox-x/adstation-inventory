import { Router } from "express";
import { prisma } from "../config/database";
import { AuthRequest, requireAuth, requirePermission } from "../middleware/auth";
import { PERMISSIONS } from "../utils/permissions";
import {
  createReturn,
  updateReturn,
  approveReturn,
  rejectReturn,
  receiveReturn,
  refundReturn,
  closeReturn,
  archiveReturn,
  listReturns,
  getReturn,
  getEligibleSourceItems,
  getReturnsDashboard,
} from "../services/returnsService";

const router = Router();

function metaOf(req: AuthRequest) {
  return {
    userId: req.user?.userId || "",
    name: req.user?.name || req.user?.email || "",
    ip: req.ip,
    userAgent: req.get("user-agent"),
  };
}

// GET /returns/sources — بنود المصدر المتاحة للإنشاء (قبل /returns/:id)
router.get("/returns/sources", requireAuth, requirePermission(PERMISSIONS.RETURNS_CREATE), async (req, res, next) => {
  try {
    const { type, sourceType, sourceId } = req.query as Record<string, string>;
    if (!type || !sourceType || !sourceId) {
      res.status(400).json({ error: "type, sourceType and sourceId query params are required" });
      return;
    }
    const result = await getEligibleSourceItems(prisma, { type, sourceType, sourceId });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /returns/reports/dashboard — لوحة مؤشرات المرتجعات
router.get("/returns/reports/dashboard", requireAuth, requirePermission(PERMISSIONS.RETURNS_VIEW), async (req, res, next) => {
  try {
    const { from, to } = req.query as Record<string, string>;
    const dashboard = await getReturnsDashboard(prisma, { from, to });
    res.json(dashboard);
  } catch (err) {
    next(err);
  }
});

// GET /returns — قائمة مع فلترة
router.get("/returns", requireAuth, requirePermission(PERMISSIONS.RETURNS_VIEW), async (req, res, next) => {
  try {
    const { status, type, search, from, to, page, limit } = req.query as Record<string, string>;
    const result = await listReturns(prisma, {
      status,
      type,
      search,
      from,
      to,
      page: Number(page),
      limit: Number(limit),
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /returns/:id — تفاصيل كاملة
router.get("/returns/:id", requireAuth, requirePermission(PERMISSIONS.RETURNS_VIEW), async (req, res, next) => {
  try {
    const ret = await getReturn(prisma, req.params.id);
    if (!ret || ret.deletedAt) {
      res.status(404).json({ error: "Return not found" });
      return;
    }
    res.json(ret);
  } catch (err) {
    next(err);
  }
});

// POST /returns — إنشاء مرتجع (draft)
router.post("/returns", requireAuth, requirePermission(PERMISSIONS.RETURNS_CREATE), async (req: AuthRequest, res, next) => {
  try {
    const ret = await createReturn(prisma, req.body, metaOf(req));
    res.status(201).json(ret);
  } catch (err) {
    next(err);
  }
});

// PUT /returns/:id — تعديل مسودة (optimistic lock عبر expectedVersion)
router.put("/returns/:id", requireAuth, requirePermission(PERMISSIONS.RETURNS_CREATE), async (req: AuthRequest, res, next) => {
  try {
    const ret = await updateReturn(prisma, req.params.id, req.body, metaOf(req));
    res.json(ret);
  } catch (err) {
    next(err);
  }
});

// POST /returns/:id/approve
router.post("/returns/:id/approve", requireAuth, requirePermission(PERMISSIONS.RETURNS_APPROVE), async (req: AuthRequest, res, next) => {
  try {
    const ret = await approveReturn(prisma, req.params.id, metaOf(req));
    res.json(ret);
  } catch (err) {
    next(err);
  }
});

// POST /returns/:id/reject
router.post("/returns/:id/reject", requireAuth, requirePermission(PERMISSIONS.RETURNS_REJECT), async (req: AuthRequest, res, next) => {
  try {
    const ret = await rejectReturn(prisma, req.params.id, metaOf(req), req.body?.reason);
    res.json(ret);
  } catch (err) {
    next(err);
  }
});

// POST /returns/:id/receive — استلام وتحديث المخزون (الخطوة الوحيدة المؤثرة على stock)
router.post("/returns/:id/receive", requireAuth, requirePermission(PERMISSIONS.RETURNS_RECEIVE), async (req: AuthRequest, res, next) => {
  try {
    const ret = await receiveReturn(prisma, req.params.id, req.body, metaOf(req));
    res.json(ret);
  } catch (err) {
    next(err);
  }
});

// POST /returns/:id/refund
router.post("/returns/:id/refund", requireAuth, requirePermission(PERMISSIONS.RETURNS_REFUND), async (req: AuthRequest, res, next) => {
  try {
    const ret = await refundReturn(prisma, req.params.id, req.body, metaOf(req));
    res.json(ret);
  } catch (err) {
    next(err);
  }
});

// POST /returns/:id/close
router.post("/returns/:id/close", requireAuth, requirePermission(PERMISSIONS.RETURNS_CLOSE), async (req: AuthRequest, res, next) => {
  try {
    const ret = await closeReturn(prisma, req.params.id, req.body, metaOf(req));
    res.json(ret);
  } catch (err) {
    next(err);
  }
});

// POST /returns/:id/archive — Soft Delete (draft only)
router.post("/returns/:id/archive", requireAuth, requirePermission(PERMISSIONS.RETURNS_CREATE), async (req: AuthRequest, res, next) => {
  try {
    const ret = await archiveReturn(prisma, req.params.id, metaOf(req));
    res.json(ret);
  } catch (err) {
    next(err);
  }
});

export default router;
