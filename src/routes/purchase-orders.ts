import { Router } from "express";
import { prisma } from "../config/database";
import { requireAuth, requirePermission, AuthRequest } from "../middleware/auth";

const router = Router();

// Status workflow
const VALID_TRANSITIONS: Record<string, string[]> = {
  draft: ["pending_approval", "cancelled"],
  pending_approval: ["approved", "cancelled"],
  approved: ["sent", "cancelled"],
  sent: ["partially_received", "received", "cancelled"],
  partially_received: ["received"],
  received: ["closed"],
  cancelled: [],
  closed: [],
};

function canTransition(from: string, to: string): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

function isEditable(status: string): boolean {
  return status === "draft" || status === "pending_approval";
}

async function generateOrderNumber(): Promise<string> {
  const year = new Date().getFullYear();
  const count = await prisma.purchaseOrder.count({
    where: { orderNumber: { startsWith: `PO-${year}-` } },
  });
  return `PO-${year}-${String(count + 1).padStart(6, "0")}`;
}

type POItemInput = { productId: string; quantity: number; unitPrice?: number; discount?: number; tax?: number };

function calcItemTotal(unitPrice: number, quantity: number, discount: number, tax: number) {
  const subtotal = unitPrice * quantity;
  const discAmt = subtotal * (discount / 100);
  const afterDiscount = subtotal - discAmt;
  const taxAmt = afterDiscount * (tax / 100);
  return { totalPrice: subtotal, afterDiscount, taxAmt, grandTotal: afterDiscount + taxAmt };
}

function calcOrderTotals(items: POItemInput[]) {
  let subtotal = 0, discount = 0, taxAmount = 0, grandTotal = 0;
  for (const i of items) {
    const up = Number(i.unitPrice || 0);
    const qty = Number(i.quantity);
    const disc = Number(i.discount || 0);
    const tax = Number(i.tax || 0);
    const r = calcItemTotal(up, qty, disc, tax);
    subtotal += r.totalPrice;
    discount += r.totalPrice - r.afterDiscount;
    taxAmount += r.taxAmt;
    grandTotal += r.grandTotal;
  }
  return { subtotal, discount, taxAmount, grandTotal };
}

// ── GET /purchase-orders — list ────────────────────────────────────────────────
router.get("/purchase-orders", requireAuth, requirePermission("purchase_orders.view"), async (req, res) => {
  try {
    const { status, supplierId, search, page = "1", limit = "50" } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    const where: any = {};
    if (status && typeof status === "string" && status !== "all") where.status = status;
    if (supplierId && typeof supplierId === "string") where.supplierId = supplierId;
    if (search && typeof search === "string") {
      where.OR = [
        { orderNumber: { contains: search, mode: "insensitive" } },
        { supplier: { name: { contains: search, mode: "insensitive" } } },
      ];
    }

    const [orders, total] = await Promise.all([
      prisma.purchaseOrder.findMany({
        where,
        include: {
          supplier: { select: { id: true, name: true } },
          items: { include: { product: { select: { id: true, name: true, barcode: true } } } },
          statusHistory: { orderBy: { createdAt: "asc" } },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: Number(limit),
      }),
      prisma.purchaseOrder.count({ where }),
    ]);

    res.json({ orders, total, page: Number(page), pages: Math.ceil(total / Number(limit)) });
  } catch (err: any) {
    console.error("[PO List]", err?.message || err);
    if (!res.headersSent) res.status(500).json({ error: "Failed to list purchase orders" });
  }
});

// ── GET /purchase-orders/:id — detail ──────────────────────────────────────────
router.get("/purchase-orders/:id", requireAuth, requirePermission("purchase_orders.view"), async (req, res) => {
  try {
    const order = await prisma.purchaseOrder.findUnique({
      where: { id: req.params.id },
      include: {
        supplier: true,
        items: { include: { product: { select: { id: true, name: true, barcode: true, stock: true } } } },
        statusHistory: { orderBy: { createdAt: "asc" } },
      },
    });
    if (!order) { res.status(404).json({ error: "Purchase order not found" }); return; }
    res.json(order);
  } catch (err: any) {
    console.error("[PO Detail]", err?.message || err);
    if (!res.headersSent) res.status(500).json({ error: "Failed to get purchase order" });
  }
});

// ── POST /purchase-orders — create ─────────────────────────────────────────────
router.post("/purchase-orders", requireAuth, requirePermission("purchase_orders.create"), async (req: AuthRequest, res) => {
  try {
    const { supplierId, expectedDeliveryDate, notes, items } = req.body;
    if (!supplierId) { res.status(400).json({ error: "Supplier is required" }); return; }
    if (!items || !Array.isArray(items) || items.length === 0) { res.status(400).json({ error: "At least one item is required" }); return; }

    const supplier = await prisma.supplier.findUnique({ where: { id: supplierId } });
    if (!supplier) { res.status(404).json({ error: "Supplier not found" }); return; }

    const productIds = items.map((i: POItemInput) => i.productId);
    const products = await prisma.product.findMany({ where: { id: { in: productIds }, deletedAt: null } });
    if (products.length !== productIds.length) { res.status(400).json({ error: "One or more products not found" }); return; }

    const orderNumber = await generateOrderNumber();
    const totals = calcOrderTotals(items);

    const order = await prisma.$transaction(async (tx) => {
      const o = await tx.purchaseOrder.create({
        data: {
          orderNumber,
          supplierId,
          expectedDeliveryDate: expectedDeliveryDate ? new Date(expectedDeliveryDate) : null,
          notes: notes?.trim() || null,
          createdBy: req.user?.userId || null,
          ...totals,
          totalAmount: totals.grandTotal,
          items: {
            create: items.map((i: POItemInput) => {
              const up = Number(i.unitPrice || 0);
              const qty = Number(i.quantity);
              const disc = Number(i.discount || 0);
              const tax = Number(i.tax || 0);
              const r = calcItemTotal(up, qty, disc, tax);
              return {
                productId: i.productId,
                quantity: qty,
                unitPrice: up,
                totalPrice: r.totalPrice,
                discount: disc,
                tax,
              };
            }),
          },
          statusHistory: {
            create: { fromStatus: null, toStatus: "draft", changedBy: req.user?.email || "system", note: "تم إنشاء أمر الشراء" },
          },
        },
        include: {
          supplier: { select: { id: true, name: true } },
          items: { include: { product: { select: { id: true, name: true, barcode: true } } } },
          statusHistory: { orderBy: { createdAt: "asc" } },
        },
      });
      return o;
    });

    res.status(201).json({ order });
  } catch (err: any) {
    console.error("[PO Create]", err?.message || err);
    if (!res.headersSent) res.status(500).json({ error: "Failed to create purchase order" });
  }
});

// ── PATCH /purchase-orders/:id — update (only if editable) ─────────────────────
router.patch("/purchase-orders/:id", requireAuth, requirePermission("purchase_orders.edit"), async (req: AuthRequest, res) => {
  try {
    const existing = await prisma.purchaseOrder.findUnique({ where: { id: req.params.id } });
    if (!existing) { res.status(404).json({ error: "Purchase order not found" }); return; }
    if (!isEditable(existing.status)) { res.status(400).json({ error: `Cannot edit order in "${existing.status}" status` }); return; }

    const { expectedDeliveryDate, notes } = req.body;
    const order = await prisma.purchaseOrder.update({
      where: { id: req.params.id },
      data: {
        ...(expectedDeliveryDate !== undefined && { expectedDeliveryDate: expectedDeliveryDate ? new Date(expectedDeliveryDate) : null }),
        ...(notes !== undefined && { notes: notes?.trim() || null }),
      },
      include: {
        supplier: { select: { id: true, name: true } },
        items: { include: { product: { select: { id: true, name: true, barcode: true } } } },
        statusHistory: { orderBy: { createdAt: "asc" } },
      },
    });
    res.json({ order });
  } catch (err: any) {
    console.error("[PO Update]", err?.message || err);
    if (!res.headersSent) res.status(500).json({ error: "Failed to update purchase order" });
  }
});

// ── POST /purchase-orders/:id/submit — draft → pending_approval ────────────────
router.post("/purchase-orders/:id/submit", requireAuth, requirePermission("purchase_orders.submit"), async (req: AuthRequest, res) => {
  try {
    const existing = await prisma.purchaseOrder.findUnique({ where: { id: req.params.id }, include: { items: true } });
    if (!existing) { res.status(404).json({ error: "Purchase order not found" }); return; }
    if (!canTransition(existing.status, "pending_approval")) { res.status(400).json({ error: `Cannot submit order in "${existing.status}" status` }); return; }
    if (existing.items.length === 0) { res.status(400).json({ error: "Cannot submit an order with no items" }); return; }

    const order = await prisma.purchaseOrder.update({
      where: { id: req.params.id },
      data: {
        status: "pending_approval",
        statusHistory: { create: { fromStatus: existing.status, toStatus: "pending_approval", changedBy: req.user?.email || "system", note: "تم تقديم الطلب للموافقة" } },
      },
      include: { supplier: { select: { id: true, name: true } }, items: { include: { product: { select: { id: true, name: true, barcode: true } } } }, statusHistory: { orderBy: { createdAt: "asc" } } },
    });
    res.json({ order });
  } catch (err: any) {
    console.error("[PO Submit]", err?.message || err);
    if (!res.headersSent) res.status(500).json({ error: "Failed to submit purchase order" });
  }
});

// ── POST /purchase-orders/:id/approve — pending_approval → approved ────────────
router.post("/purchase-orders/:id/approve", requireAuth, requirePermission("purchase_orders.approve"), async (req: AuthRequest, res) => {
  try {
    const existing = await prisma.purchaseOrder.findUnique({ where: { id: req.params.id } });
    if (!existing) { res.status(404).json({ error: "Purchase order not found" }); return; }
    if (!canTransition(existing.status, "approved")) { res.status(400).json({ error: `Cannot approve order in "${existing.status}" status` }); return; }

    const order = await prisma.purchaseOrder.update({
      where: { id: req.params.id },
      data: {
        status: "approved",
        approvedBy: req.user?.email || "system",
        approvedAt: new Date(),
        statusHistory: { create: { fromStatus: existing.status, toStatus: "approved", changedBy: req.user?.email || "system", note: "تم اعتماد الطلب" } },
      },
      include: { supplier: { select: { id: true, name: true } }, items: { include: { product: { select: { id: true, name: true, barcode: true } } } }, statusHistory: { orderBy: { createdAt: "asc" } } },
    });
    res.json({ order });
  } catch (err: any) {
    console.error("[PO Approve]", err?.message || err);
    if (!res.headersSent) res.status(500).json({ error: "Failed to approve purchase order" });
  }
});

// ── POST /purchase-orders/:id/send — approved → sent ───────────────────────────
router.post("/purchase-orders/:id/send", requireAuth, requirePermission("purchase_orders.edit"), async (req: AuthRequest, res) => {
  try {
    const existing = await prisma.purchaseOrder.findUnique({ where: { id: req.params.id } });
    if (!existing) { res.status(404).json({ error: "Purchase order not found" }); return; }
    if (!canTransition(existing.status, "sent")) { res.status(400).json({ error: `Cannot send order in "${existing.status}" status` }); return; }

    const order = await prisma.purchaseOrder.update({
      where: { id: req.params.id },
      data: {
        status: "sent",
        statusHistory: { create: { fromStatus: existing.status, toStatus: "sent", changedBy: req.user?.email || "system", note: "تم إرسال الطلب للمورد" } },
      },
      include: { supplier: { select: { id: true, name: true } }, items: { include: { product: { select: { id: true, name: true, barcode: true } } } }, statusHistory: { orderBy: { createdAt: "asc" } } },
    });
    res.json({ order });
  } catch (err: any) {
    console.error("[PO Send]", err?.message || err);
    if (!res.headersSent) res.status(500).json({ error: "Failed to send purchase order" });
  }
});

// ── POST /purchase-orders/:id/cancel — any active → cancelled ──────────────────
router.post("/purchase-orders/:id/cancel", requireAuth, requirePermission("purchase_orders.cancel"), async (req: AuthRequest, res) => {
  try {
    const existing = await prisma.purchaseOrder.findUnique({ where: { id: req.params.id } });
    if (!existing) { res.status(404).json({ error: "Purchase order not found" }); return; }
    if (!canTransition(existing.status, "cancelled")) { res.status(400).json({ error: `Cannot cancel order in "${existing.status}" status` }); return; }

    const order = await prisma.purchaseOrder.update({
      where: { id: req.params.id },
      data: {
        status: "cancelled",
        statusHistory: { create: { fromStatus: existing.status, toStatus: "cancelled", changedBy: req.user?.email || "system", note: req.body?.note || "تم إلغاء الطلب" } },
      },
      include: { supplier: { select: { id: true, name: true } }, items: { include: { product: { select: { id: true, name: true, barcode: true } } } }, statusHistory: { orderBy: { createdAt: "asc" } } },
    });
    res.json({ order });
  } catch (err: any) {
    console.error("[PO Cancel]", err?.message || err);
    if (!res.headersSent) res.status(500).json({ error: "Failed to cancel purchase order" });
  }
});

// ── POST /purchase-orders/:id/close — received → closed ────────────────────────
router.post("/purchase-orders/:id/close", requireAuth, requirePermission("purchase_orders.close"), async (req: AuthRequest, res) => {
  try {
    const existing = await prisma.purchaseOrder.findUnique({ where: { id: req.params.id } });
    if (!existing) { res.status(404).json({ error: "Purchase order not found" }); return; }
    if (!canTransition(existing.status, "closed")) { res.status(400).json({ error: `Cannot close order in "${existing.status}" status` }); return; }

    const order = await prisma.purchaseOrder.update({
      where: { id: req.params.id },
      data: {
        status: "closed",
        statusHistory: { create: { fromStatus: existing.status, toStatus: "closed", changedBy: req.user?.email || "system", note: "تم إغلاق الطلب" } },
      },
      include: { supplier: { select: { id: true, name: true } }, items: { include: { product: { select: { id: true, name: true, barcode: true } } } }, statusHistory: { orderBy: { createdAt: "asc" } } },
    });
    res.json({ order });
  } catch (err: any) {
    console.error("[PO Close]", err?.message || err);
    if (!res.headersSent) res.status(500).json({ error: "Failed to close purchase order" });
  }
});

// ── POST /purchase-orders/:id/receive — receive items (atomic, with accepted/rejected) ──
router.post("/purchase-orders/:id/receive", requireAuth, requirePermission("purchase_orders.receive"), async (req: AuthRequest, res) => {
  try {
    const { receivedQuantities } = req.body;
    // receivedQuantities: { [itemId]: { receivedQty: number, acceptedQty: number, rejectedQty: number } }

    if (!receivedQuantities || typeof receivedQuantities !== "object") {
      res.status(400).json({ error: "receivedQuantities map is required" });
      return;
    }

    const order = await prisma.purchaseOrder.findUnique({
      where: { id: req.params.id },
      include: { items: true, supplier: true },
    });

    if (!order) { res.status(404).json({ error: "Purchase order not found" }); return; }
    if (order.status === "cancelled" || order.status === "closed") { res.status(400).json({ error: `Cannot receive items for a ${order.status} order` }); return; }
    if (order.status === "received") { res.status(400).json({ error: "Order already fully received" }); return; }

    const updates: { productId: string; acceptedQty: number; itemId: string; receivedQty: number }[] = [];
    for (const item of order.items) {
      const r = receivedQuantities[item.id];
      if (!r || !r.receivedQty) continue;
      const acceptedQty = r.acceptedQty ?? r.receivedQty;
      const rejectedQty = r.rejectedQty ?? 0;
      if (acceptedQty + rejectedQty > r.receivedQty) {
        res.status(400).json({ error: `Item ${item.id}: accepted + rejected cannot exceed received` });
        return;
      }
      if (acceptedQty < 0 || rejectedQty < 0 || r.receivedQty < 0) {
        res.status(400).json({ error: `Item ${item.id}: quantities cannot be negative` });
        return;
      }
      const alreadyReceived = item.receivedQuantity;
      if (alreadyReceived + r.receivedQty > item.quantity) {
        res.status(400).json({ error: `Item ${item.id}: total received (${alreadyReceived + r.receivedQty}) would exceed ordered quantity (${item.quantity})` });
        return;
      }
      updates.push({ productId: item.productId, acceptedQty, itemId: item.id, receivedQty: r.receivedQty });
    }

    if (updates.length === 0) { res.status(400).json({ error: "No valid items to receive" }); return; }

    await prisma.$transaction(async (tx) => {
      for (const u of updates) {
        // Read current stock BEFORE increment for accurate inventory log
        const stockBefore = await tx.product.findUnique({ where: { id: u.productId }, select: { stock: true, name: true } });
        const oldStock = stockBefore?.stock ?? 0;

        if (u.acceptedQty > 0) {
          await tx.product.update({
            where: { id: u.productId },
            data: { stock: { increment: u.acceptedQty } },
          });
        }

        await tx.purchaseOrderItem.update({
          where: { id: u.itemId },
          data: {
            receivedQuantity: { increment: u.receivedQty },
            acceptedQty: { increment: u.acceptedQty },
            rejectedQty: { increment: u.receivedQty - u.acceptedQty },
          },
        });

        if (u.acceptedQty > 0) {
          const newStock = oldStock + u.acceptedQty;
          await tx.inventoryLog.create({
            data: {
              productId: u.productId,
              type: "purchase_receive",
              change: u.acceptedQty,
              oldStock,
              newStock,
              notes: `استلام وارد أمر الشراء ${order.orderNumber} — ${stockBefore?.name || ""}`,
              referenceType: "purchase_order",
              referenceId: order.id,
              userId: req.user?.userId,
              userName: req.user?.name,
              userRole: req.user?.role,
              entityType: "purchase_order",
              entityId: order.id,
              beforeData: { stock: oldStock },
              afterData: { stock: newStock },
            },
          });
        }
      }

      const updatedItems = await tx.purchaseOrderItem.findMany({ where: { orderId: order.id } });
      const allFullyReceived = updatedItems.every((item) => item.acceptedQty >= item.quantity);
      const newStatus = allFullyReceived ? "received" : "partially_received";

      await tx.purchaseOrder.update({
        where: { id: order.id },
        data: {
          status: newStatus,
          actualDeliveryDate: allFullyReceived ? new Date() : undefined,
          statusHistory: {
            create: {
              fromStatus: order.status,
              toStatus: newStatus,
              changedBy: req.user?.email || "system",
              note: allFullyReceived ? "تم استلام كل المنتجات" : "تم استلام جزئي",
            },
          },
        },
      });
    });

    const updatedOrder = await prisma.purchaseOrder.findUnique({
      where: { id: order.id },
      include: {
        supplier: { select: { id: true, name: true } },
        items: { include: { product: { select: { id: true, name: true, barcode: true } } } },
        statusHistory: { orderBy: { createdAt: "asc" } },
      },
    });

    res.json({ order: updatedOrder, message: "Items received and stock updated" });
  } catch (err: any) {
    console.error("[PO Receive]", err?.message || err);
    if (!res.headersSent) res.status(500).json({ error: "Failed to receive items" });
  }
});

export default router;
