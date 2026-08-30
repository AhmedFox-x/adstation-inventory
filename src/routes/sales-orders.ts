import { Router } from "express";
import { prisma } from "../config/database";
import { AuthRequest, requireAuth, requirePermission } from "../middleware/auth";
import { createError } from "../middleware/errorHandler";
import { PERMISSIONS } from "../utils/permissions";
import { resolveClientPrice, hasPriceListPermission } from "../services/priceListService";
import { recordStockInsufficient } from "../services/anomalyService";
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

// ─────────────────────────────────────────────────────────────────────────────
// سياسة أسعار الـ Price List على أوامر البيع:
//  - لو العميل ليه قائمة سعر (خاصة/محددة/افتراضية) والمنتج متسعّر فيها →
//    بيتم حفظ listPrice/listTier على الـ item (List/Actual/Discount في الواجهة).
//  - أي انحراف عن سعر القائمة = "تعديل يدوي" ≈ محتاج صلاحية price_lists.override.
//  - من غير قائمة سعر → السلوك القديم يفضل زيه (السعر اللي ادخله المستخدم).
// ─────────────────────────────────────────────────────────────────────────────
async function applyPricePolicy(req: AuthRequest, body: any): Promise<any> {
  if (!body || !Array.isArray(body.items) || !body.clientId) return body;
  const perms = req.user?.permissions || [];
  const items = [...body.items];

  for (const it of items) {
    const resolved = await resolveClientPrice(prisma, body.clientId, it.productId);
    if (resolved.listPrice === null) continue; // من غير قائمة → سلوك قديم

    it.listPrice = resolved.listPrice;
    it.listTier = resolved.tier;

    const selling = Number(it.sellingPrice) || 0;
    if (selling > 0 && Math.abs(selling - resolved.listPrice) > 0.001) {
      if (!hasPriceListPermission(perms, PERMISSIONS.PRICE_LISTS_OVERRIDE)) {
        throw createError(
          `Manual price override requires the price_lists.override permission (list price ${resolved.listPrice})`,
          403
        );
      }
    }
  }

  return { ...body, items };
}

async function logInsufficientStockAnomaly(err: any, ctx: { orderId?: string; clientId?: string; actor?: string }) {
  if (err && err.status === 409 && typeof err.message === "string" && /Insufficient stock/i.test(err.message)) {
    try {
      await recordStockInsufficient(prisma, {
        productIds: [],
        message: typeof err.message === "string" ? err.message : "Insufficient stock",
        actor: ctx.actor,
        entityType: "sales_order",
        entityId: ctx.orderId || `client_${ctx.clientId || "unknown"}`,
      });
    } catch (e) {
      console.warn("[sales-orders] anomaly record for insufficient stock failed:", (e as Error).message);
    }
  }
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
    const body = await applyPricePolicy(req, req.body);
    const order = await createOrder(prisma, body, metaOf(req));
    res.status(201).json(order);
  } catch (err) {
    await logInsufficientStockAnomaly(err, { clientId: req.body?.clientId, actor: req.user?.userId });
    next(err);
  }
});

// PUT /sales-orders/:id — تعديل مسودة
router.put("/sales-orders/:id", requireAuth, requirePermission(PERMISSIONS.SALES_ORDERS_EDIT_DRAFT), async (req: AuthRequest, res, next) => {
  try {
    const body = await applyPricePolicy(req, req.body);
    const order = await updateOrder(prisma, req.params.id, body, metaOf(req));
    res.json(order);
  } catch (err) {
    await logInsufficientStockAnomaly(err, { orderId: req.params.id, clientId: req.body?.clientId, actor: req.user?.userId });
    next(err);
  }
});

// POST /sales-orders/:id/confirm
router.post("/sales-orders/:id/confirm", requireAuth, requirePermission(PERMISSIONS.SALES_ORDERS_CONFIRM), async (req: AuthRequest, res, next) => {
  try {
    const order = await confirmOrder(prisma, req.params.id, metaOf(req));
    res.json(order);
  } catch (err) {
    await logInsufficientStockAnomaly(err, { orderId: req.params.id, actor: req.user?.userId });
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
    const m = metaOf(req);
    const order = await rejectOrder(prisma, req.params.id, m as any, { ip: m.ip, userAgent: m.userAgent }, req.body?.reason);
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
    const m = metaOf(req);
    const order = await cancelOrder(prisma, req.params.id, m as any, { ip: m.ip, userAgent: m.userAgent }, req.body?.note);
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