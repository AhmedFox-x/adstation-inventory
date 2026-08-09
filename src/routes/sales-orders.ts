import { Router } from "express";
import { prisma } from "../config/database";
import { AuthRequest, requireAuth, requirePermission } from "../middleware/auth";
import { PERMISSIONS } from "../utils/permissions";
import {
  createOrder,
  updateOrder,
  confirmOrder,
  approveOrder,
  rejectOrder,
  transitionToProcessing,
  transitionToShipped,
  deliverOrder,
  transitionToClosed,
  cancelOrder,
  listOrders,
  getOrder,
  getOrderDeliveries,
} from "../services/salesOrderService";

const router = Router();

function metaOf(req: AuthRequest) {
  return {
    userId: req.user?.userId || "",
    name: req.user?.name || req.user?.email || "",
    ip: req.ip,
    userAgent: req.get("user-agent"),
  };
}

// GET /sales-orders — قائمة مع فلترة
router.get("/sales-orders", requireAuth, requirePermission(PERMISSIONS.SALES_ORDERS_VIEW), async (req, res, next) => {
  try {
    const { status, clientId, search, from, to, page, limit } = req.query as Record<string, string>;
    const result = await listOrders(prisma, {
      status,
      clientId,
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

// GET /sales-orders/:id — تفاصيل
router.get("/sales-orders/:id", requireAuth, requirePermission(PERMISSIONS.SALES_ORDERS_VIEW), async (req, res, next) => {
  try {
    const order = await getOrder(prisma, req.params.id);
    if (!order || order.deletedAt) {
      res.status(404).json({ error: "Sales order not found" });
      return;
    }
    res.json(order);
  } catch (err) {
    next(err);
  }
});

// POST /sales-orders — إنشاء مسودة
router.post("/sales-orders", requireAuth, requirePermission(PERMISSIONS.SALES_ORDERS_CREATE), async (req: AuthRequest, res, next) => {
  try {
    const order = await createOrder(prisma, req.body, metaOf(req));
    res.status(201).json(order);
  } catch (err) {
    next(err);
  }
});

// PUT /sales-orders/:id — تعديل مسودة
router.put("/sales-orders/:id", requireAuth, requirePermission(PERMISSIONS.SALES_ORDERS_EDIT_DRAFT), async (req: AuthRequest, res, next) => {
  try {
    const order = await updateOrder(prisma, req.params.id, req.body, metaOf(req));
    res.json(order);
  } catch (err) {
    next(err);
  }
});

// POST /sales-orders/:id/confirm
router.post("/sales-orders/:id/confirm", requireAuth, requirePermission(PERMISSIONS.SALES_ORDERS_CONFIRM), async (req: AuthRequest, res, next) => {
  try {
    const order = await confirmOrder(prisma, req.params.id, metaOf(req));
    res.json(order);
  } catch (err) {
    next(err);
  }
});

// POST /sales-orders/:id/process
router.post("/sales-orders/:id/process", requireAuth, requirePermission(PERMISSIONS.SALES_ORDERS_PROCESS), async (req: AuthRequest, res, next) => {
  try {
    const order = await transitionToProcessing(prisma, req.params.id, metaOf(req));
    res.json(order);
  } catch (err) {
    next(err);
  }
});

// POST /sales-orders/:id/ship
router.post("/sales-orders/:id/ship", requireAuth, requirePermission(PERMISSIONS.SALES_ORDERS_SHIP), async (req: AuthRequest, res, next) => {
  try {
    const order = await transitionToShipped(prisma, req.params.id, metaOf(req));
    res.json(order);
  } catch (err) {
    next(err);
  }
});

// POST /sales-orders/:id/deliver
router.post("/sales-orders/:id/deliver", requireAuth, requirePermission(PERMISSIONS.SALES_ORDERS_DELIVER), async (req: AuthRequest, res, next) => {
  try {
    const order = await deliverOrder(prisma, req.params.id, req.body, metaOf(req));
    res.json(order);
  } catch (err) {
    next(err);
  }
});

// POST /sales-orders/:id/approve
router.post("/sales-orders/:id/approve", requireAuth, requirePermission(PERMISSIONS.SALES_ORDERS_APPROVE), async (req: AuthRequest, res, next) => {
  try {
    const order = await approveOrder(prisma, req.params.id, metaOf(req), req.body?.note);
    res.json(order);
  } catch (err) {
    next(err);
  }
});

// POST /sales-orders/:id/reject
router.post("/sales-orders/:id/reject", requireAuth, requirePermission(PERMISSIONS.SALES_ORDERS_REJECT), async (req: AuthRequest, res, next) => {
  try {
    const order = await rejectOrder(prisma, req.params.id, metaOf(req), req.body?.reason);
    res.json(order);
  } catch (err) {
    next(err);
  }
});

// POST /sales-orders/:id/close
router.post("/sales-orders/:id/close", requireAuth, requirePermission(PERMISSIONS.SALES_ORDERS_CLOSE), async (req: AuthRequest, res, next) => {
  try {
    const order = await transitionToClosed(prisma, req.params.id, metaOf(req));
    res.json(order);
  } catch (err) {
    next(err);
  }
});

// POST /sales-orders/:id/cancel
router.post("/sales-orders/:id/cancel", requireAuth, requirePermission(PERMISSIONS.SALES_ORDERS_CANCEL), async (req: AuthRequest, res, next) => {
  try {
    const order = await cancelOrder(prisma, req.params.id, metaOf(req), req.body?.note);
    res.json(order);
  } catch (err) {
    next(err);
  }
});

// GET /sales-orders/:id/deliveries — سجل التوصيلات
router.get("/sales-orders/:id/deliveries", requireAuth, requirePermission(PERMISSIONS.SALES_ORDERS_VIEW), async (req, res, next) => {
  try {
    const deliveries = await getOrderDeliveries(prisma, req.params.id);
    res.json({ deliveries });
  } catch (err) {
    next(err);
  }
});

export default router;
