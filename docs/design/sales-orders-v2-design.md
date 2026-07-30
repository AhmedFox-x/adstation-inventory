# Sales Orders v2 — Design Freeze Document

> **Phase 0**: تم اعتماد هذا المستند كمرجع رسمي لتنفيذ الميزة. ممنوع تغيير أي عنصر فيه بعد بدء التنفيذ إلا بسبب واضح وبعد موافقة مالك المشروع.
> تاريخ الاعتماد: 2026-07-31

---

## 1. Business Workflow

```
[Create Draft] → [Confirm] → [Process] → [Ship] → [Deliver] → [Close]
                      ↓           ↓          ↓          ↓
                  Auto-Reserve  (pick)    (dispatch)   Partial OK
```

### 1.1 User Stories

| Actor | Story |
|-------|-------|
| Manager | ينشئ طلب بيع جديد لعميل، ويعدل في المسودة، ويؤكد الطلب |
| Manager | يشحن الطلب ويوثق التوصيل (كلي أو جزئي) |
| Owner | يعتمد الطلبات الكبيرة (أعلى من حد معين) قبل التوصيل |
| Viewer | يشاهد حالة الطلبات والتقارير فقط |

### 1.2 Flow Details

| Step | Who | What happens |
|------|-----|-------------|
| Create | Manager | يدخل العميل + المنتجات + الكميات + السعر. الحالة: `draft` |
| Confirm | Manager | يتحقق من توفر المخزون → يحجز الكمية (`reservedStock += qty`). الحالة: `confirmed` |
| Process | Manager | تحضير الطلب للتوصيل. الحالة: `processing` |
| Ship | Manager | شحن الطلب. الحالة: `shipped` |
| Deliver | Manager/Driver | يسلم الكميات الفعلية → ينقص `reservedStock` + `stock`. الحالة: `delivered` أو `partially_delivered` |
| Close | Manager | إغلاق الطلب نهائيًا. الحالة: `closed` |
| Cancel | Manager | إلغاء الطلب ← يرجع `reservedStock`. الحالة: `cancelled` |

### 1.3 Approval Gate (جديد)

- إذا `grandTotal > APPROVAL_THRESHOLD (5000 EGP)`، الطلب **لازم يوخذ APPROVAL** قبل ما يوصل
- الـ Manager يقدر يعمل Confirm و Process و Ship
- لكن الـ **Owner** بس اللي يقدر يعمل Deliver لو total > threshold
- لو total ≤ threshold، الـ Manager يقدر يكمل للتوصيل مباشة

---

## 2. Status Machine

### 2.1 Valid Transitions

```
                ┌──────────┐
                │  draft   │
                └────┬─────┘
                     │
                ┌────▼─────┐
                │ confirmed │
                └────┬─────┘
                     │
                ┌────▼─────┐
                │processing│
                └────┬─────┘
                     │
                ┌────▼─────┐
                │  shipped  │
                └────┬─────┘
                     │
           ┌─────────┼──────────┐
           │         │          │
     ┌─────▼──────┐ ┌▼────────┐ │
     │delivered   │ │partially│ │
     │            │ │delivered│ │
     └─────┬──────┘ └────┬────┘ │
           │             │      │
           └──────┬──────┘      │
                  │             │
             ┌────▼─────┐       │
             │  closed   │       │
             └──────────┘       │
                           ┌────▼─────┐
                           │cancelled │
                           └──────────┘
```

### 2.2 Transition Table

| From | To | Requires | Notes |
|------|----|----------|-------|
| draft | confirmed | Stock check | Auto-reserve (atomic `increment reservedStock`) |
| draft | cancelled | — | Only if no items delivered |
| confirmed | processing | — | |
| confirmed | cancelled | — | Releases reservedStock |
| processing | shipped | — | |
| processing | cancelled | — | Releases reservedStock |
| shipped | delivered | Delivery items | Atomic stock decrement |
| shipped | partially_delivered | Delivery items | Partial delivery |
| shipped | cancelled | — | Only if no items delivered |
| partially_delivered | delivered | Remaining items | |
| partially_delivered | cancelled | — | Only undelivered qty releases reserved |
| delivered | closed | — | Final state |
| cancelled | *none* | — | Terminal state |
| closed | *none* | — | Terminal state |

### 2.3 Expiry Rule

- الطلبات اللي حالتها `draft` أو `confirmed` و `expiresAt` عدى الوقت الحالي → **auto-cancel**
- التشغيل: قبل أي عملية transition (في middleware أو قبل كل transition)
- الـ auto-cancel يحرر `reservedStock` وينشئ `SalesOrderStatusHistory` بـ `changedBy: "system"`

---

## 3. Final Schema

### 3.1 Model Changes (مضافة فوق الموجود)

```prisma
// ===== Product تعديل =====
model Product {
  // الحقول الموجودة ...
  unit      String   @default("قطعة")    // ➕ جديد

  deliveryItems SalesDeliveryItem[]       // ➕ جديد
}

// ===== SalesOrderItem تعديل =====
model SalesOrderItem {
  // الحقول الموجودة ...
  productName  String?                    // ➕ Snapshot
  productSku   String?                    // ➕ Snapshot
  unit         String?                    // ➕ Snapshot
}

// ===== SalesOrderStatusHistory تعديل =====
model SalesOrderStatusHistory {
  // الحقول الموجودة ...
  ip        String?                       // ➕ جديد
  userAgent String?                       // ➕ جديد
}

// ===== نماذج جديدة =====
model SalesDelivery {
  id              String   @id @default(cuid())
  salesOrderId    String
  deliveryNumber  String   @unique
  deliveredAt     DateTime @default(now())
  deliveredBy     String?
  notes           String?
  createdAt       DateTime @default(now())

  salesOrder SalesOrder          @relation(fields: [salesOrderId], references: [id])
  items      SalesDeliveryItem[]

  @@index([salesOrderId])
}

model SalesDeliveryItem {
  id             String  @id @default(cuid())
  deliveryId     String
  salesOrderItemId String
  productId      String
  quantity       Int
  unit           String?

  delivery      SalesDelivery  @relation(fields: [deliveryId], references: [id], onDelete: Cascade)
  salesOrderItem SalesOrderItem @relation(fields: [salesOrderItemId], references: [id])
  product       Product        @relation(fields: [productId], references: [id])
}

model Notification {
  id        String   @id @default(cuid())
  userId    String?
  type      String   // low_stock | order_confirmed | order_delivered | order_expired | approval_needed
  title     String
  message   String
  referenceType String?  // sales_order | purchase_order | product
  referenceId   String?
  isRead    Boolean  @default(false)
  createdAt DateTime @default(now())
}
```

### 3.2 Product Snapshot Detail

عند إنشاء `SalesOrderItem`، بناخد Snapshot من الـ Product وقتها:
- `productName` ← `product.name`
- `productSku` ← `product.sku`
- `unit` ← `product.unit`

ده عشان لو العميل غير اسم المنتج بعدين، الـ Order القديم يفضل شايف القيمة اللي كانت وقت الطلب.

### 3.3 Audit Trail Detail

في `SalesOrderStatusHistory` بنضيف:
- `ip` — عنوان IP اللي عمل الـ transition
- `userAgent` — الـ User-Agent بتاع الطلب

بيتم تسجيلهم آليًا من `req.ip` و `req.headers['user-agent']` في كل transition.

### 3.4 Partial Delivery Detail

- كل `SalesOrderItem` عنده `orderedQty` و `deliveredQty`
- في كل delivery: نضيف سجل في `SalesDeliveryItem` بالكمية الفعلية
- نقارن `sum(deliveredQty)` بـ `orderedQty` لكل item:
  - لو كل items اكتملت → `delivered`
  - لو في items ناقصة → `partially_delivered`
- الـ `reservedStock` بتتنقص بنفس كمية الـ delivery (مش كل الكمية)

---

## 4. Permissions

### 4.1 Permission List

| Permission | Phase | Roles | Notes |
|-----------|-------|-------|-------|
| `sales_orders.view` | P2 | Owner, Manager | |
| `sales_orders.create` | P2 | Owner, Manager | |
| `sales_orders.edit_draft` | P2 | Owner, Manager | Only draft |
| `sales_orders.confirm` | P2 | Owner, Manager | |
| `sales_orders.process` | P2 | Owner, Manager | |
| `sales_orders.ship` | P2 | Owner, Manager | |
| `sales_orders.deliver` | P2 | Owner, Manager | Manager فقط لو ≤ threshold |
| `sales_orders.approve` | P2 | Owner فقط | **جديد** — لاعتماد الطلبات فوق الـ threshold |
| `sales_orders.close` | P2 | Owner, Manager | |
| `sales_orders.cancel` | P2 | Owner, Manager | |

### 4.2 Role Mapping

| Role | Sales Order Permissions |
|------|------------------------|
| owner | الكل (10) |
| manager | الكل ما عدا `approve` (9) — مع شرط threshold على `deliver` |
| viewer | `view` فقط |

### 4.3 Business Rule: Threshold Enforcement

فى الـ Backend:
- لو `grandTotal > 5000` والمستخدم الحالي `role === manager`:
  - `deliver` → ممنوع (403) إلا لو الطلب معتمد (`approvedAt !== null`)
  - أي محاولة `deliver` مباشة لطلب غير معتمد تترفض
- الـ `approve` متاحة لـ Owner بس

---

## 5. API Endpoints

### 5.1 Endpoint List

| Method | Path | Permission | Phase | Notes |
|--------|------|-----------|-------|-------|
| GET | `/api/sales-orders` | view | P3 | Pagination, filters (status, clientId, date, search) |
| GET | `/api/sales-orders/:id` | view | P3 | Full detail + items + history + deliveries |
| POST | `/api/sales-orders` | create | P3 | Body: clientId, items[], reference, expectedDeliveryDate, expiresAt, notes |
| PUT | `/api/sales-orders/:id` | edit_draft | P3 | Only if status === draft |
| POST | `/api/sales-orders/:id/confirm` | confirm | P3 | Auto-reserve, stock check |
| POST | `/api/sales-orders/:id/process` | process | P3 | |
| POST | `/api/sales-orders/:id/ship` | ship | P3 | |
| POST | `/api/sales-orders/:id/deliver` | deliver | P3 | Body: deliveredItems[{itemId, deliveredQty}]; checks approval threshold |
| POST | `/api/sales-orders/:id/approve` | approve | P3 | **جديد** — Body: { note? }; sets approvedAt, approvedBy |
| POST | `/api/sales-orders/:id/close` | close | P3 | |
| POST | `/api/sales-orders/:id/cancel` | cancel | P3 | Releases reservedStock |
| GET | `/api/sales-orders/:id/deliveries` | view | P3 | **جديد** — History of all deliveries |
| GET | `/api/notifications` | view | P3 | **جديد** — List notifications for current user |
| PUT | `/api/notifications/:id/read` | view | P3 | **جديد** — Mark notification as read |

### 5.2 Request/Response

#### POST /api/sales-orders

```typescript
// Request
{
  clientId: string;
  reference?: string;
  expectedDeliveryDate?: string; // ISO date
  expiresAt?: string;            // ISO date
  notes?: string;
  items: Array<{
    productId: string;
    orderedQty: number;
    sellingPrice: number;
    discount?: number;
    tax?: number;
  }>;
}

// Response — 201
{
  id: string;
  orderNumber: string;
  status: "draft";
  client: { id: string; name: string };
  items: Array<{
    id: string;
    productId: string;
    productName: string;
    productSku: string;
    unit: string;
    orderedQty: number;
    sellingPrice: number;
    costPrice: number;
    totalPrice: number;
  }>;
  subtotal: number;
  grandTotal: number;
  statusHistory: Array<{ toStatus: string; createdAt: string }>;
}
```

#### POST /api/sales-orders/:id/deliver

```typescript
// Request
{
  deliveredItems: Array<{ itemId: string; deliveredQty: number }>;
  notes?: string;
}
```

#### POST /api/sales-orders/:id/approve

```typescript
// Request
{
  note?: string;
}

// Response
{
  id: string;
  status: string;
  approvedAt: string;
  approvedBy: string;
}
```

---

## 6. Transactions

| Operation | Tables affected | Transaction | Rollback behavior |
|-----------|---------------|------------|-------------------|
| Confirm | SalesOrder (status) + SalesOrderStatusHistory + Product (reservedStock) | ✅ `$transaction` | لو فشل الـ reservedStock، ميحصلش transition |
| Deliver | SalesOrder (status) + SalesOrderStatusHistory + SalesDelivery + SalesDeliveryItem + SalesOrderItem (deliveredQty) + Product (stock + reservedStock) | ✅ `$transaction` | لو أي item فشل، الكل يرجع |
| Cancel | SalesOrder (status) + SalesOrderStatusHistory + Product (reservedStock) | ✅ `$transaction` | لو فشل تحرير المخزون، ميحصلش transition |
| Approve | SalesOrder (approvedAt + approvedBy) + SalesOrderStatusHistory + Notification | ✅ `$transaction` | كامل |
| Create | SalesOrder + SalesOrderItem (snapshot) + SalesOrderStatusHistory | ❌ عملية واحدة | Create本身就是 atomic |

**قاعدة**:** كل عملية بتغير أكتر من جدول لازم تكون جوه `$transaction` مع rollback عند الفشل.

---

## 7. KPIs (Dashboard)

| KPI | Source | Phase | SQL/Pseudo |
|-----|--------|-------|------------|
| عدد الطلبات النشطة (confirmed → shipped) | SalesOrder | P6 | `COUNT(*) WHERE status IN ('confirmed','processing','shipped','partially_delivered')` |
| إجمالي مبيعات الشهر | SalesOrder | P6 | `SUM(grandTotal) WHERE status IN ('delivered','closed') AND orderDate >= startOfMonth` |
| الطلبات المتأخرة (overdue) | SalesOrder | P6 | `COUNT(*) WHERE expectedDeliveryDate < NOW() AND status NOT IN ('delivered','closed','cancelled')` |
| طلبات في انتظار الاعتماد | SalesOrder | P6 | `COUNT(*) WHERE status = 'shipped' AND grandTotal > 5000 AND approvedAt IS NULL` |
| أفضل 5 عملاء مبيعات | SalesOrder + Client | P6 | `GROUP BY clientId ORDER BY SUM(grandTotal) DESC LIMIT 5` |
| آخر 10 طلبات | SalesOrder | P6 | `ORDER BY createdAt DESC LIMIT 10` |

---

## 8. Notifications

| Type | Trigger | Message | Target |
|------|---------|---------|--------|
| `order_confirmed` | Confirm success | "تم تأكيد الطلب {orderNumber} للعميل {clientName}" | Manager |
| `order_delivered` | Deliver success | "تم توصيل الطلب {orderNumber}" | Manager |
| `order_approved` | Approve success | "تم اعتماد الطلب {orderNumber}" | Manager |
| `order_expired` | Auto-cancel | "تم إلغاء الطلب {orderNumber} لانتهاء صلاحيته" | Manager |
| `approval_needed` | Confirm of order > 5000 | "الطلب {orderNumber} يحتاج اعتماد من المالك (قيمته {grandTotal} ج.م)" | Owner فقط |
| `low_stock` | After deliver (if stock ≤ minStock) | "المخزون من {productName} وصل {stock} (الحد الأدنى: {minStock})" | Manager + Owner |

الـ Notifications بتتنشأ جوه نفس `$transaction` بتاعة العملية الأصلية عشان لو فشلت، ميحصلش notification من غير حدث حقيقي.

---

## 9. Audit

| Data Point | Storage | Detail |
|-----------|---------|--------|
| Status transition | SalesOrderStatusHistory | fromStatus, toStatus, changedBy, createdAt, **ip**, **userAgent** |
| Delivery record | SalesDelivery + SalesDeliveryItem | deliveredBy, deliveredAt, quantity لكل item |
| Approval record | SalesOrder (approvedAt, approvedBy) + SalesOrderStatusHistory | مين اعتمد وإمتى |
| Product snapshot | SalesOrderItem (productName, productSku, unit) | القيمة وقت الطلب (مش بتتغير بعدين) |

**ممنوع حذف أي من هذه السجلات** — حتى soft delete. هي Append-Only.

---

## 10. Rules Summary

| Rule | Detail | Enforcement |
|------|--------|------------|
| Partial Delivery | كل item عنده deliveredQty منفصلة — لو مش كل items اكتملت → `partially_delivered` | Backend transition logic |
| Order Expiry | Draft/Confirmed orders with `expiresAt < NOW()` → auto-cancel | Before every transition |
| Approval Threshold | `grandTotal > 5000 EGP` → needs `approve` before `deliver` لغير Owner | Middleware في route deliver |
| Reserved Stock | Confirm → `reservedStock += qty`; Deliver → `reservedStock -= deliveredQty`; Cancel → release all | Atomic increment/decrement |
| Snapshot Frozen | Product name/SKU/unit تُسجل وقت إنشاء الـ order ومبتتغيرش | Written at create time |
| No Hard Delete | ممنوع DELETE على أي سجل ليه تاريخ حركة | DB-level (relation checks) |
| Transaction Safety | كل multi-table operation جوه `$transaction` | Code review rule |
| Notification Consistency | الـ Notifications بتتنشأ جوه نفس transaction بتاعة الحدث | Code review rule |
| Audit Completeness | كل status transition يسجل IP + User Agent | Middleware |

---

## Appendix: Implementation Phases

| Phase | Scope | Files |
|-------|-------|-------|
| P0 | Design Freeze | هذا المستند |
| P1 | Schema + Migration | `schema.prisma`, `prisma/migrations/` |
| P2 | Permissions + Seed | `permissions.ts`, `seed.ts` |
| P3 | Backend | `sales-orders.ts`, `notifications.ts` |
| P4 | Frontend API | `api.ts` |
| P5 | UI | `SalesOrdersPage.tsx`, `App.tsx`, `Layout.tsx` |
| P6 | Dashboard + Docs + Tests + Report | `DashboardPage.tsx`, locales, tests, executive report |

---

*End of Design Freeze Document. Any change requires explicit approval.*
