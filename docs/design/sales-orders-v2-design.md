# Sales Orders v2 — Design Freeze Document

> **Phase 0**: تم اعتماد هذا المستند كمرجع رسمي لتنفيذ الميزة. ممنوع تغيير أي عنصر فيه بعد بدء التنفيذ إلا بسبب واضح وبعد موافقة مالك المشروع.
> تاريخ الاعتماد: 2026-07-31

---

## 1. Business Workflow

```
[Create Draft] → [Confirm] → [Process] → [Ship] → [Deliver] → [Close]
                      ↓           ↓          ↓          ↓
                  Auto-Reserve  (pick)    (dispatch)   Partial OK
                                                        ↓
                                                   [Approve] ← إذا فوق threshold
```

### 1.1 User Stories

| Actor | Story |
|-------|-------|
| Manager | ينشئ طلب بيع جديد لعميل، ويعدل في المسودة، ويؤكد الطلب |
| Manager | يشحن الطلب ويوثق التوصيل (كلي أو جزئي) |
| Owner | يعتمد الطلبات الكبيرة (أعلى من حد معين) قبل التوصيل |
| Owner | يرفض الطلبات الكبيرة مع سبب |
| Viewer | يشاهد حالة الطلبات والتقارير فقط |

### 1.2 Flow Details

| Step | Who | What happens |
|------|-----|-------------|
| Create | Manager | يدخل العميل + المنتجات + الكميات + السعر. الحالة: `draft` |
| Confirm | Manager | يتحقق من توفر المخزون → يحجز الكمية (`reservedStock += qty`). الحالة: `confirmed`. لو total > threshold → تنشأ Notification للمالك |
| Process | Manager | تحضير الطلب للتوصيل. الحالة: `processing` |
| Ship | Manager | شحن الطلب. الحالة: `shipped` |
| Approve | Owner | اعتماد طلب كبير. الحالة: `approvalStatus = approved` |
| Reject | Owner | رفض طلب كبير مع سبب. الحالة: `approvalStatus = rejected` |
| Deliver | Manager/Owner | يسلم الكميات الفعلية → ينقص `reservedStock` + `stock`. الحالة: `delivered` أو `partially_delivered` |
| Close | Manager | إغلاق الطلب نهائيًا. الحالة: `closed` |
| Cancel | Manager | إلغاء الطلب ← يرجع `reservedStock`. الحالة: `cancelled` |

### 1.3 Approval Gate

حد الاعتماد (threshold) مخزّن في **جدول إعدادات منفصل (`SystemSettings`)** مش hardcoded.
الحقل: `salesApprovalThreshold`, القيمة الافتراضية: `5000` (بالجنيه).

**الـ Approval هو Gate قبل Confirm، مش شرط قبل Deliver:**

| السيناريو | اللي بيحصل |
|-----------|-----------|
| `grandTotal ≤ threshold` | Confirm عادي → `status = confirmed` + Reserve تلقائي |
| `grandTotal > threshold` | محاولة Confirm → `approvalStatus = pending` + Notification للمالك. **الـ Status يفضل `draft`**. **مفيش Reserve** |
| Owner → Approve | `status = confirmed` + `approvalStatus = approved` + Reserve تلقائي. Notification للمنشئ |
| Owner → Reject | `approvalStatus = rejected` + `rejectionNote`. Notification للمنشئ. الطلب يفضل `draft` — يقدر المنشئ يعدل الكميات ويحاول تاني |

**ليه كده؟** عشان ميحصلش Reserve لطلبات لسه مرفوضة. المخزون بيتحجز بس بعد الموافقة.

صاحب الشركة يقدر يغير الـ threshold من غير ما يحتاج deploy.

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
| draft | confirmed | Stock check + Approval check | لو فوق threshold: Confirm يفضل draft مع approvalStatus=pending. Confirm الفعلي بيحصل بس بعد Approve |
| draft | cancelled | — | Only if no items delivered |
| confirmed | processing | — | |
| confirmed | cancelled | — | Releases reservedStock بالكامل |
| processing | shipped | — | |
| processing | cancelled | — | Releases reservedStock بالكامل |
| shipped | delivered | Delivery items | Atomic stock + reservedStock decrement |
| shipped | partially_delivered | Delivery items | Partial delivery (reservation لسه active للباقي) |
| shipped | cancelled | — | Only if no items delivered |
| partially_delivered | delivered | Remaining items | |
| partially_delivered | cancelled | — | يرجع reservedStock للكمية المتبقية فقط: `reservedStock -= (orderedQty - deliveredQty)` |
| delivered | closed | — | Final state |
| cancelled | *none* | — | Terminal state |
| closed | *none* | — | Terminal state |

### 2.3 Expiry Rule

- الطلبات اللي حالتها `draft` أو `confirmed` و `expiresAt` عدى الوقت الحالي → **auto-cancel**
- التشغيل:
  - **Daily Job** (أو كل ساعة) لو في Scheduler — هو الحل الأمثل
  - لو مفيش Scheduler: `expireSalesOrders()` تتنادى قبل **confirm, process, ship, deliver** فقط
  - **ممنوع** استدعاؤها قبل `GET` — لأن GET مش المفروض يغير Database
- الـ auto-cancel يحرر `reservedStock` وينشئ `SalesOrderStatusHistory` بـ `changedBy: "system"` ويخلق `Notification` من نوع `order_expired`

---

## 3. Final Schema

### 3.1 Model Changes (مضافة فوق الموجود)

```prisma
// ===== نظام جديد: الإعدادات =====
model SystemSettings {
  id        String   @id @default(cuid())
  key       String   @unique
  value     String
  updatedAt DateTime @updatedAt
}

// ===== Product تعديل =====
model Product {
  // الحقول الموجودة ...
  unit      String   @default("قطعة")    // ➕ جديد

  deliveryItems SalesDeliveryItem[]       // ➕ جديد
}

// ===== Reservation تعديل =====
model Reservation {
  // الحقول الموجودة ...
  salesOrderItemId String?                 // ➕ جديد — ربط الـ Reservation بـ item معين في الطلب (مش الطلب كله)
  fulfilledQty     Int     @default(0)    // ➕ جديد — الكمية اللي اتنفذت فعليًا من الحجز ده
}

// ===== SalesOrderItem تعديل =====
model SalesOrderItem {
  // الحقول الموجودة ...
  productName  String?                    // ➕ Snapshot
  productSku   String?                    // ➕ Snapshot
  unit         String?                    // ➕ Snapshot
  barcode      String?                    // ➕ Snapshot
  category     String?                    // ➕ Snapshot
  brand        String?                    // ➕ Snapshot
}

// ===== SalesOrder تعديل =====
model SalesOrder {
  // الحقول الموجودة ...
  approvalStatus String @default("none")  // ➕ جديد: none | pending | approved | rejected
  approvedAt     DateTime?
  approvedBy     String?
  rejectionNote  String?                  // ➕ جديد — سبب الرفض
}

// ===== SalesOrderStatusHistory تعديل =====
model SalesOrderStatusHistory {
  // الحقول الموجودة ...
  ip        String?                       // ➕ جديد
  userAgent String?                       // ➕ جديد
  beforeState Json?                       // ➕ جديد — Snapshot JSON للحالة قبل التغيير
  afterState  Json?                       // ➕ جديد — Snapshot JSON للحالة بعد التغيير
}

// ===== نماذج جديدة =====
model SalesDelivery {
  id              String   @id @default(cuid())
  salesOrderId    String
  deliveryNumber  String   @unique
  deliveredAt     DateTime @default(now())
  deliveredBy     String?
  driverName      String?                  // ➕ اسم السائق
  vehicle         String?                  // ➕ رقم العربية / نوعها
  proofImage      String?                  // ➕ صورة إثبات التوصيل (Base64)
  signature       String?                  // ➕ توقيع العميل (Base64)
  gpsLocation     String?                  // ➕ موقع التوصيل (lat,lng)
  notes           String?
  createdAt       DateTime @default(now())

  salesOrder SalesOrder          @relation(fields: [salesOrderId], references: [id])
  items      SalesDeliveryItem[]

  @@index([salesOrderId])
}

model SalesDeliveryItem {
  id              String  @id @default(cuid())
  deliveryId      String
  salesOrderItemId String
  productId       String
  quantity        Int
  unit            String?

  delivery       SalesDelivery  @relation(fields: [deliveryId], references: [id], onDelete: Cascade)
  salesOrderItem SalesOrderItem @relation(fields: [salesOrderItemId], references: [id])
  product        Product        @relation(fields: [productId], references: [id])
}

model Notification {
  id              String    @id @default(cuid())
  userId          String?
  type            String    // low_stock | order_confirmed | order_delivered | order_expired | approval_needed | order_approved | order_rejected
  title           String
  message         String
  referenceType   String?   // sales_order | purchase_order | product
  referenceId     String?
  priority        String    @default("normal")  // low | normal | high | urgent
  icon            String?                       // اسم الأيقونة (lucide)
  actionUrl       String?                       // رابط مباشة للصفحة المعنية
  createdBySystem Boolean   @default(false)
  isRead          Boolean   @default(false)
  readAt          DateTime?
  deletedAt       DateTime?
  createdAt       DateTime  @default(now())
}

// ===== Indexes إضافية =====
// SalesOrder: @@index([orderNumber])
// SalesOrder: @@index([status])
// SalesOrder: @@index([clientId])
// SalesOrder: @@index([expectedDeliveryDate])
// SalesOrder: @@index([createdAt])
// SalesOrder: @@index([approvalStatus])
// SalesOrderItem: @@index([productId])
// SalesOrderStatusHistory: @@index([orderId, createdAt])
// SalesDelivery: @@index([salesOrderId])
// SalesDelivery: @@index([deliveredAt])
// Notification: @@index([userId, isRead, createdAt])
```

### 3.2 Product Snapshot Detail

عند إنشاء `SalesOrderItem`، بناخد Snapshot من الـ Product وقتها:
- `productName` ← `product.name`
- `productSku` ← `product.sku`
- `barcode` ← `product.barcode`
- `category` ← `product.category`
- `brand` ← `product.brand` (لو موجود — هيضاف كحقل جديد بعدين)
- `unit` ← `product.unit`

ده عشان لو العميل غير بيانات المنتج بعدين، الـ Order القديم يفضل شايف القيمة اللي كانت وقت الطلب.

### 3.3 Cost Price — Moving Average

سعر التكلفة في `SalesOrderItem.costPrice` بيتحسب كـ **Moving Average**:

```
movingAvgCost = totalCostOfAllPurchases / totalQuantityPurchased
```

التفاصيل:
- المصدر: `PurchaseOrderItem` حيث `PurchaseOrder.status === "received"`
- كل ما يدخل أمر شراء جديد معتمد، يتحدّث الـ Moving Average
- وقت **Confirm أو Approve** (مش وقت الإنشاء)، بنسجل قيمة `movingAvgCost` الحالية في `costPrice`
  - لو الطلب أقل من threshold: Snapshot أخذ عند Confirm
  - لو الطلب فوق threshold: Snapshot أخذ عند Approve
- **ليه مش وقت الإنشاء أو التوصيل؟** لأن متوسط التكلفة ممكن يتغير بين اليومين، ونفسر我们把 القيمة وقت اعتماد الطلب مش وقت التوصيل
- لو مفيش مشتريات خالص للمنتج: `costPrice = 0` (أو يقدر المستخدم يدخله يدويًا)

### 3.4 Partial Delivery — Reservation Tracking

- كل `Reservation` مرتبط بـ `SalesOrderItem` (مش بالـ Order كامل)، وكل item ليه Reservation مستقل
- عند Confirm/Approve: `reservedStock += orderedQty` للـ item، وبنشئ Reservation مع `salesOrderItemId`
- عند Deliver:
  - الكمية الموصلة بتخصم من `reservedStock` وبتزود `fulfilledQty` في الـ Reservation
  - الـ Reservation **يفضل Active** طالما `fulfilledQty < orderedQty` (ordered = 100, fulfilled = 30, remaining = 70)
  - Reservation يتقفل بس لما `fulfilledQty >= orderedQty`
- Cancel بعد Partial: `reservedStock -= (orderedQty - deliveredQty)` — مش `orderedQty`
- ده بيسمح بتتبع دقيق: أي reservation اتنفذ قد إيه، وأي جزء لسه متبقي

### 3.5 Approval Status

- `approvalStatus` بقيمة: `none` (مافيش approval مطلوب) | `pending` | `approved` | `rejected`
- القيمة الافتراضية: `none`
- لو `grandTotal > threshold` عند Confirm: `approvalStatus = pending`
- الـ Owner يعمل `approve` → `approvalStatus = approved`, `approvedAt`, `approvedBy`
- الـ Owner يعمل `reject` → `approvalStatus = rejected`, `rejectionNote`
- الـ Manager مش قادر يعدل approvalStatus خالص (صلاحية `approve` لـ Owner بس)

### 3.6 Audit Snapshots

- `SalesOrderStatusHistory.beforeState`: JSON للـ Order كامل قبل الـ transition
- `SalesOrderStatusHistory.afterState`: JSON للـ Order كامل بعد الـ transition
- بيسمح بعمل مقارنة دقيقة: إيه اللي اتغير بالظبط

### 3.8 Schema Tests (Phase 2)

قبل أي Backend أو Permissions، نكتب اختبارات للـ Schema نفسه:

| Test | What it verifies |
|------|-----------------|
| Migration Up | إن الـ migration الجديد يشتغل من غير أخطار على Database فاضية |
| Foreign Keys | `SalesOrder.clientId → Client.id`، `SalesOrderItem.productId → Product.id`، `SalesDelivery.salesOrderId → SalesOrder.id`، إلخ |
| Unique Constraints | `SalesOrder.orderNumber`، `SalesDelivery.deliveryNumber` |
| Indexes | إن الـ indexes المطلوبة اتعملت (خصوصًا `@@index([status])`، `@@index([clientId])`، `@@index([createdAt])`) |
| Default Values | `SalesOrder.status = "draft"`، `SalesOrder.approvalStatus = "none"`، `Product.unit = "قطعة"`، `Notification.priority = "normal"` |
| Required Fields | إن `clientId` و `items` مطلوبين في `SalesOrder` |
| Cascade Delete | `SalesOrderItem` يتحدف لما `SalesOrder` يتحدف (onDelete: Cascade) |

**الهدف:** التأكد إن الـ Schema نفسه صحيح قبل ما نكتب أي business logic فوقيه.

### 3.9 Order Number Format

- الصيغة: `SO-YYYYMM-NNNNNN`
- مثال: `SO-202607-000001`
- الترقيم شهري (يعيد من 1 كل شهر جديد)
- يتحقق من uniqueness في نطاق الشهر (يجيب آخر رقم في الشهر الحالي ويزيد 1)

---

## 4. Permissions

### 4.1 Permission List

| Permission | Phase | Roles | Notes |
|-----------|-------|-------|-------|
| `sales_orders.view` | P3 | Owner, Manager | |
| `sales_orders.create` | P3 | Owner, Manager | |
| `sales_orders.edit_draft` | P3 | Owner, Manager | Only draft |
| `sales_orders.confirm` | P3 | Owner, Manager | |
| `sales_orders.process` | P3 | Owner, Manager | |
| `sales_orders.ship` | P3 | Owner, Manager | |
| `sales_orders.deliver` | P3 | Owner, Manager | Manager فقط لو معتمد أو أقل من threshold |
| `sales_orders.approve` | P3 | Owner فقط | اعتماد الطلبات فوق الـ threshold |
| `sales_orders.reject` | P3 | Owner فقط | رفض الطلبات مع سبب |
| `sales_orders.close` | P3 | Owner, Manager | |
| `sales_orders.cancel` | P3 | Owner, Manager | |

### 4.2 Role Mapping

| Role | Sales Order Permissions |
|------|------------------------|
| owner | الكل (11) |
| manager | الكل ما عدا `approve` و `reject` (9) — مع شرط threshold على `deliver` |
| viewer | `view` فقط |

### 4.3 Approval Threshold Enforcement

فى الـ Backend:
- قبل `confirm`:
  - لو `grandTotal ≤ salesApprovalThreshold` (من `SystemSettings`) → Confirm عادي: `status = confirmed`, Reserve
  - لو `grandTotal > salesApprovalThreshold` → `approvalStatus = pending`, `status` يفضل `draft`, Notification للمالك. **مفيش Reserve**
- الـ `approve`: Owner بس. بيحول `status = confirmed` ويعمل Reserve ويسجل costPrice Snapshot
- الـ `reject`: Owner بس. `approvalStatus = rejected`, `rejectionNote`, Notification للمنشئ
- لو `approvalStatus === "rejected"` → ممنوع الـ Confirm. يقدر المنشئ يعدل الطلب ويعمل Confirm تاني
- قبل `deliver`: لو `approvalStatus === "pending"` → 403 لأي دور

---

## 5. API Endpoints

### 5.1 Endpoint List

| Method | Path | Permission | Phase | Notes |
|--------|------|-----------|-------|-------|
| GET | `/api/sales-orders` | view | P4 | Pagination + filters (see 5.3) |
| GET | `/api/sales-orders/:id` | view | P4 | Full detail + items + history + deliveries |
| POST | `/api/sales-orders` | create | P4 | Body: clientId, items[], reference, expectedDeliveryDate, expiresAt, notes |
| PUT | `/api/sales-orders/:id` | edit_draft | P4 | Only if status === draft |
| POST | `/api/sales-orders/:id/confirm` | confirm | P4 | Auto-reserve, stock check, approval check |
| POST | `/api/sales-orders/:id/process` | process | P4 | |
| POST | `/api/sales-orders/:id/ship` | ship | P4 | |
| POST | `/api/sales-orders/:id/deliver` | deliver | P4 | Body: deliveredItems[{itemId, deliveredQty}]; checks approval |
| POST | `/api/sales-orders/:id/approve` | approve | P4 | Body: { note? }; sets approvalStatus=approved |
| POST | `/api/sales-orders/:id/reject` | reject | P4 | Body: { reason }; sets approvalStatus=rejected |
| POST | `/api/sales-orders/:id/close` | close | P4 | |
| POST | `/api/sales-orders/:id/cancel` | cancel | P4 | Releases reservedStock |
| GET | `/api/sales-orders/:id/deliveries` | view | P4 | History of all deliveries |
| GET | `/api/notifications` | view | P4 | List notifications for current user |
| PUT | `/api/notifications/:id/read` | view | P4 | Mark notification as read |

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
  orderNumber: string;           // SO-202607-000001
  status: "draft";
  approvalStatus: "none";
  client: { id: string; name: string };
  items: Array<{
    id: string;
    productId: string;
    productName: string;
    productSku: string;
    barcode: string;
    category: string;
    brand: string;
    unit: string;
    orderedQty: number;
    sellingPrice: number;
    costPrice: number;            // Moving Average
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
  driverName?: string;
  vehicle?: string;
  proofImage?: string;   // Base64
  signature?: string;    // Base64
  gpsLocation?: string;  // "30.0444,31.2357"
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
  approvalStatus: "approved";
  approvedAt: string;
  approvedBy: string;
}
```

#### POST /api/sales-orders/:id/reject

```typescript
// Request
{
  reason: string;
}

// Response
{
  id: string;
  status: string;
  approvalStatus: "rejected";
  rejectionNote: string;
}
```

### 5.3 Pagination & Filters

```typescript
// GET /api/sales-orders?page=1&limit=20&sort=createdAt&order=desc
//   &search=مصطفى
//   &status=confirmed,processing
//   &client=clientId
//   &from=2026-07-01&to=2026-07-31

{
  orders: SalesOrder[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}
```

---

## 6. Transactions

| Operation | Tables affected | Transaction | Rollback behavior |
|-----------|---------------|------------|-------------------|
| Confirm (≤ threshold) | SalesOrder (status) + SalesOrderStatusHistory + Product (reservedStock) + Reservation + costPrice Snapshot + Notification + InventoryLog | ✅ `$transaction` | لو فشل الـ reservedStock أو الـ Notification، ميحصلش transition |
| Approve (was pending) | SalesOrder (status → confirmed + approvalStatus) + SalesOrderStatusHistory + Product (reservedStock) + Reservation + costPrice Snapshot + Notification + InventoryLog | ✅ `$transaction` | زي Confirm بالظبط — الـ Reserve بيتعمل هنا مش في Confirm |
| Pending Confirm (> threshold) | SalesOrder (approvalStatus → pending) + SalesOrderStatusHistory + Notification | ✅ `$transaction` | مفيش Reserve لسه — مجرد إشعار |
| Deliver | SalesOrder (status) + SalesOrderStatusHistory + SalesDelivery + SalesDeliveryItem + SalesOrderItem (deliveredQty) + Reservation (fulfilledQty, status) + Product (stock + reservedStock) + InventoryLog | ✅ `$transaction` | لو أي item فشل، الكل يرجع. الـ Reservation يفضل Active لو باقي remaining |
| Cancel (confirmed+) | SalesOrder (status) + SalesOrderStatusHistory + Reservation (status → cancelled) + Product (reservedStock) + InventoryLog | ✅ `$transaction` | لو فشل تحرير المخزون، ميحصلش transition |
| Cancel (draft/pending) | SalesOrder (status) + SalesOrderStatusHistory | ❌ مفيش Reserve | مجرد تغيير status |
| Approve | SalesOrder (approvalStatus + approvedAt + approvedBy) + SalesOrderStatusHistory + Notification | ✅ `$transaction` | كامل |
| Reject | SalesOrder (approvalStatus + rejectionNote) + SalesOrderStatusHistory + Notification | ✅ `$transaction` | كامل |
| Create | SalesOrder + SalesOrderItem (snapshot) + SalesOrderStatusHistory + (Reservation لو auto-reserve?) | ❌ عملية واحدة | Create نفسه atomic |

**قاعدة:** كل عملية بتغير أكتر من جدول — ومن ضمنها دايمًا **`InventoryLog`** — لازم تكون جوه `$transaction` مع rollback عند الفشل.

### InventoryLog في العمليات

كل عملية من العمليات دي تسجل `InventoryLog`:

| Process | Log type | Detail |
|---------|----------|--------|
| Confirm | `reservation` | "حجز {qty} وحدة من {product} للطلب {orderNumber}" |
| Deliver | `sale` | "صرف {qty} وحدة من {product} للتوصيل للطلب {orderNumber}" |
| Cancel (confirmed+) | `release` | "إلغاء حجز {qty} وحدة من {product} للطلب {orderNumber}" |

---

## 7. KPIs (Dashboard)

| KPI | Source | Phase | SQL/Pseudo |
|-----|--------|-------|------------|
| عدد الطلبات النشطة (confirmed → shipped) | SalesOrder | P8 | `COUNT(*) WHERE status IN ('confirmed','processing','shipped','partially_delivered')` |
| إجمالي مبيعات الشهر | SalesOrder | P8 | `SUM(grandTotal) WHERE status IN ('delivered','closed') AND orderDate >= startOfMonth` |
| إجمالي الربح الشهري (Gross Profit) | SalesOrderItem | P8 | `SUM((sellingPrice - costPrice) * deliveredQty) WHERE order.status IN ('delivered','closed') AND order.orderDate >= startOfMonth` |
| الطلبات المتأخرة (overdue) | SalesOrder | P8 | `COUNT(*) WHERE expectedDeliveryDate < NOW() AND status NOT IN ('delivered','closed','cancelled')` |
| طلبات في انتظار الاعتماد | SalesOrder | P8 | `COUNT(*) WHERE approvalStatus = 'pending'` |
| أفضل 5 عملاء مبيعات (شهري) | SalesOrder + Client | P8 | `GROUP BY clientId ORDER BY SUM(grandTotal) DESC LIMIT 5` |
| آخر 10 طلبات | SalesOrder | P8 | `ORDER BY createdAt DESC LIMIT 10` |

---

## 8. Notifications

| Type | Trigger | Message | Target | Priority |
|------|---------|---------|--------|----------|
| `order_confirmed` | Confirm success | "تم تأكيد الطلب {orderNumber} للعميل {clientName}" | Manager | normal |
| `order_delivered` | Deliver success | "تم توصيل الطلب {orderNumber}" | Manager | normal |
| `order_approved` | Approve success | "تم اعتماد الطلب {orderNumber}" | Manager | high |
| `order_rejected` | Reject | "تم رفض الطلب {orderNumber} — {reason}" | Manager | urgent |
| `order_expired` | Auto-cancel | "تم إلغاء الطلب {orderNumber} لانتهاء صلاحيته" | Manager | low |
| `approval_needed` | Confirm where > threshold | "الطلب {orderNumber} من {clientName} يحتاج اعتماد (قيمته {grandTotal} ج.م)" | Owner | high |
| `low_stock` | Deliver where stock ≤ minStock | "المخزون من {productName} وصل {stock} (الحد الأدنى: {minStock})" | Manager + Owner | urgent |

كل Notification بتتنشأ جوه نفس `$transaction` بتاعة العملية الأصلية — لو فشلت العملية، مفيش Notification يتخلق.

---

## 9. Audit

| Data Point | Storage | Detail |
|-----------|---------|--------|
| Status transition | SalesOrderStatusHistory | fromStatus, toStatus, changedBy, createdAt, **ip**, **userAgent** |
| State snapshot | SalesOrderStatusHistory.beforeState / afterState | JSON كامل للطلب قبل وبعد — مقارنة دقيقة |
| Delivery record | SalesDelivery + SalesDeliveryItem | deliveredBy, driverName, vehicle, proofImage, signature, gpsLocation, quantity لكل item |
| Approval record | SalesOrder (approvalStatus, approvedAt, approvedBy, rejectionNote) + SalesOrderStatusHistory | مين اعتمد/رفض وإمتى وليه |
| Product snapshot | SalesOrderItem (productName, productSku, barcode, category, brand, unit) | القيمة وقت الطلب (مش بتتغير بعدين) |

**ممنوع حذف أي من هذه السجلات** — حتى soft delete. هي Append-Only.

---

## 10. Rules Summary

| Rule | Detail | Enforcement |
|------|--------|------------|
| Partial Delivery | كل item عنده deliveredQty منفصلة — لو مش كل items اكتملت → `partially_delivered` | Backend transition logic |
| Order Expiry | Draft/Confirmed orders with `expiresAt < NOW()` → auto-cancel | Daily job OR قبل confirm/process/ship/deliver — **مش قبل GET** |
| Approval Gate Before Reserve | `grandTotal > salesApprovalThreshold` → Confirm بيحط `approvalStatus = pending` بس. Reserve و costPrice Snapshot بيتعملوا بعد Approve فقط | Middleware في route confirm |
| Reserved Stock | Confirm → `reservedStock += qty`; Deliver → `reservedStock -= deliveredQty`; Cancel → `reservedStock -= (orderedQty - deliveredQty)` | Atomic increment/decrement |
| Snapshot Frozen | Product name/SKU/barcode/category/brand/unit تُسجل وقت الإنشاء ومبتتغيرش | Written at create time |
| Soft Delete Only | ممنوع DELETE على أي سجل ليه تاريخ حركة — Soft Delete (`deletedAt`) فقط | DB-level + route check |
| Transaction Safety | كل multi-table operation جوه `$transaction` — ودايمًا تتضمن InventoryLog | Code review rule |
| Notification Consistency | الـ Notifications بتتنشأ جوه نفس transaction بتاعة الحدث | Code review rule |
| Audit Completeness | كل status transition يسجل IP + User Agent + before/after JSON | Middleware |
| Cost Price — Moving Average | `costPrice` من moving average لآخر PurchaseOrder معتمد | Snapshot عند Confirm (أقل من threshold) أو Approve (فوق threshold) — مش وقت الإنشاء |
| No Hard Delete for Orders | ممنوع DELETE على SalesOrder لأي سبب — `isArchived` أو `deletedAt` فقط | Route-level enforcement |

---

## Appendix: Implementation Phases

| Phase | Scope | Files | Tests |
|-------|-------|-------|-------|
| P0 | Design Freeze | هذا المستند | — |
| P1 | Schema + Migration + Backup | `schema.prisma`, `prisma/migrations/` | — |
| P2 | Schema Tests | `tests/schema/` | ✅ Migration Up, Foreign Keys, Unique Constraints, Indexes, Default Values |
| P3 | Permissions + Seed | `permissions.ts`, `seed.ts` | ✅ تأكيد إن Owner لسه عنده صلاحياته |
| P4 | Backend | `sales-orders.ts`, `notifications.ts`, routes | ✅ Backend Integration Tests |
| P5 | Backend Tests | `tests/sales-orders/` | ✅ Positive + Negative لكل endpoint |
| P6 | Frontend API | `api.ts` | — |
| P7 | Frontend | `SalesOrdersPage.tsx`, `App.tsx`, `Layout.tsx` | — |
| P8 | Dashboard | `DashboardPage.tsx`, locales (`ar.ts`, `en.ts`) | — |
| P9 | Documentation | README, API docs, permissions doc | ✅ توثيق كامل |
| P10 | Executive Report | `docs/reports/YYYY-MM-DD-sales-orders-v2.html` | ✅ تقرير تنفيذي للمدير |

---

*End of Design Freeze Document. Any change requires explicit approval.*
