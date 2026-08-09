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
| Approve | Owner | اعتماد طلب كبير. `SalesOrderApproval(status=approved)` |
| Reject | Owner | رفض طلب كبير مع سبب. `SalesOrderApproval(status=rejected, reason)` |
| Deliver | Manager/Owner | يسلم الكميات الفعلية → ينقص `reservedStock` + `stock`. الحالة: `delivered` أو `partially_delivered` |
| Close | Manager | إغلاق الطلب نهائيًا. الحالة: `closed` |
| Cancel | Manager | إلغاء الطلب ← يرجع `reservedStock`. الحالة: `cancelled` |

### 1.3 Approval Gate

حد الاعتماد مخزّن في **جدول إعدادات منفصل (`SystemSettings`)**:
- `approvalThresholdValue` — القيمة (افتراضي: `5000`)
- `approvalThresholdCurrency` — العملة (افتراضي: `EGP`)

**كل Approval هو Entity مستقل (`SalesOrderApproval`)** — مش مجرد حقول على الـ Order.

**الـ Approval هو Gate قبل Confirm، مش شرط قبل Deliver:**

| السيناريو | اللي بيحصل |
|-----------|-----------|
| `grandTotal ≤ threshold` | Confirm عادي → `status = confirmed` + Reserve تلقائي |
| `grandTotal > threshold` | محاولة Confirm → `SalesOrderApproval(status=pending)` + Notification للمالك. **الـ Status يفضل `draft`**. **مفيش Reserve** |
| Owner → Approve | `SalesOrderApproval(status=approved)` + `status = confirmed` + Reserve تلقائي. Notification للمنشئ |
| Owner → Reject | `SalesOrderApproval(status=rejected, reason)` + Notification للمنشئ. الطلب يفضل `draft` — يقدر المنشئ يعدل الكميات ويحاول تاني |

**ليه Entity مستقل؟** عشان بعد سنة ممكن نضيف موافقة المدير المالي أو الإدارة من غير ما نكسر الـ Schema — كل مستوى Approval هيكون سجل جديد في نفس الجدول.

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
| draft | confirmed | Stock check + Approval check | لو فوق threshold: Confirm يفضل draft مع SalesOrderApproval(pending). Confirm الفعلي بيحصل بس بعد Approve |
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

### 2.4 Status Machine Locked (Service Layer)

**ممنوع نهائيًا أي Route يغيّر `status` مباشرة.** كل التحويلات بتمر من Service واحدة:

```
src/services/salesOrderService.ts
  └── transitionToConfirmed(id, user, tx)    // كل الـ validation جوه
  └── transitionToProcessing(id, user, tx)
  └── transitionToShipped(id, user, tx)
  └── transitionToDelivered(id, user, tx, deliveredItems)
  └── transitionToClosed(id, user, tx)
  └── transitionToCancelled(id, user, tx)
  └── approve(id, user, tx)
  └── reject(id, user, tx, reason)
```

- الـ Routes بتنادي الـ Service فقط
- كل الـ Validations (status machine, permission, stock check, approval check) جوه الـ Service
- مستحيل حد يكتب `data: { status: "processing" }` في أي Route
- الـ Service بيستخدم `version` (Optimistic Locking) للتحكم في الـ Concurrency (نقطة 15)

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
  warehouseId      String?                 // ➕ جديد — جاهز لـ Multi-Warehouse مستقبلًا
  fulfilledQty     Int     @default(0)    // ➕ جديد — الكمية اللي اتنفذت فعليًا من الحجز ده
}

// ===== SalesOrderItem تعديل — Snapshot كامل =====
model SalesOrderItem {
  // الحقول الموجودة ...
  productName    String?    // ➕ Snapshot
  productSku     String?    // ➕ Snapshot
  unit           String?    // ➕ Snapshot
  barcode        String?    // ➕ Snapshot
  category       String?    // ➕ Snapshot
  brand          String?    // ➕ Snapshot
  costPrice      Float?     // Moving Average — Snapshot عند Confirm/Approve
  sellingPrice   Float?     // سعر البيع المجمد
  taxRate        Float?    @default(0)   // ➕ سعر الضريبة المجمد (لو اتغير بعدين)
  discountRate   Float?    @default(0)   // ➕ نسبة الخصم المجمدة
  currency       String?   @default("EGP") // ➕ العملة المجمدة
  exchangeRate   Float?    @default(1)   // ➕ سعر الصرف المجمد
}

// ===== SalesOrder تعديل =====
model SalesOrder {
  // الحقول الموجودة ...
  version        Int      @default(1)    // ➕ Optimistic Locking — بيعلى كل update
  deletedAt      DateTime?               // ➕ Soft Delete
  deletedBy      String?                 // ➕ مين عمل soft delete

  approvals      SalesOrderApproval[]    // ➕ entity مستقل للـ approvals
}

// ===== كيان جديد: Approval مستقل =====
model SalesOrderApproval {
  id           String   @id @default(cuid())
  salesOrderId String
  status       String   // pending | approved | rejected
  requestedBy  String?  // اللي طلب الاعتماد
  approvedBy   String?  // اللي اعتمد
  rejectedBy   String?  // اللي رفض
  reason       String?  // سبب الرفض/الاعتماد
  createdAt    DateTime @default(now())
  approvedAt   DateTime?
  rejectedAt   DateTime?

  salesOrder SalesOrder @relation(fields: [salesOrderId], references: [id], onDelete: Cascade)

  @@index([salesOrderId, status])
}

// ===== SalesOrderStatusHistory تعديل =====
model SalesOrderStatusHistory {
  // الحقول الموجودة ...
  ip            String?                    // ➕ جديد
  userAgent     String?                    // ➕ جديد
  beforeState   Json?                      // ➕ جديد — Snapshot JSON للحالة قبل التغيير
  afterState    Json?                      // ➕ جديد — Snapshot JSON للحالة بعد التغيير
  changedFields String[]?                  // ➕ جديد — مثال: ["status", "approvedBy"] — قراءة أسهل
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
  entityType      String?   // ➕ sales_order | purchase_order | product | delivery — الـ Frontend بيستخدمها للتنقل الذكي
  entityId        String?   // ➕ id الكيان
  referenceType   String?   // sales_order | purchase_order | product (backward compat)
  referenceId     String?
  priority        String    @default("normal")  // low | normal | high | urgent
  icon            String?                       // اسم الأيقونة (lucide)
  actionUrl       String?                       // اختياري — لو entityType مش كفاية
  createdBySystem Boolean   @default(false)
  isRead          Boolean   @default(false)
  readAt          DateTime?
  deletedAt       DateTime?
  createdAt       DateTime  @default(now())

  @@index([userId, isRead, createdAt])
}

// ===== InventoryLog: type يبقى Enum بدل String =====
enum InventoryLogType {
  SALES_ORDER
  PURCHASE_ORDER
  WITHDRAWAL
  SUPPLY
  STOCKTAKE
  ADJUSTMENT
  RETURN
  RESERVATION
  RELEASE
  SYSTEM
}

model InventoryLog {
  // الحقول الموجودة ...
  type          InventoryLogType   // ➕ Enum مش String
  // باقي الحقول زي ما هي ...
}

// ===== Indexes إضافية — مركبة (Composite) =====
// SalesOrder: @@index([orderNumber])
// SalesOrder: @@index([status, createdAt])          // ➕ مركب — للـ filters الشائعة
// SalesOrder: @@index([clientId, createdAt])        // ➕ مركب — تقارير العميل
// SalesOrder: @@index([expectedDeliveryDate])
// SalesOrderItem: @@index([productId])
// SalesOrderStatusHistory: @@index([orderId, createdAt])
// SalesDelivery: @@index([salesOrderId])
// SalesDelivery: @@index([deliveredAt])
// Notification: @@index([userId, isRead, createdAt])
// SalesOrderApproval: @@index([salesOrderId, status])
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

### 3.3 Price Freeze — Moving Average (تكلفة) + سعر بيع + ضريبة + عملة

**التجميد الكامل للسعر وقت اعتماد الطلب:**

| الحقل | المصدر | التوقيت |
|-------|--------|---------|
| `costPrice` | Moving Average (آخر PurchaseOrder معتمد) | Confirm (أقل من threshold) أو Approve (فوق threshold) |
| `sellingPrice` | اللي دخلته وقت الإنشاء | Confirm/Approve |
| `taxRate` | الـ Product وقتها | Confirm/Approve |
| `discountRate` | نسبة الخصم وقتها | Confirm/Approve |
| `currency` | العملة وقتها (افتراضي EGP) | Confirm/Approve |
| `exchangeRate` | سعر الصرف وقتها (افتراضي 1) | Confirm/Approve |

**Cost Price — Moving Average:**
```
movingAvgCost = totalCostOfAllPurchases / totalQuantityPurchased
```

- المصدر: `PurchaseOrderItem` حيث `PurchaseOrder.status === "received"`
- كل ما يدخل أمر شراء جديد معتمد، يتحدّث الـ Moving Average
- **ليه مش وقت الإنشاء أو التوصيل؟** لأن متوسط التكلفة ممكن يتغير بين اليومين — فبنجمد القيمة وقت اعتماد الطلب (Confirm أو Approve)
- لو مفيش مشتريات خالص للمنتج: `costPrice = 0` (أو يقدر المستخدم يدخله يدويًا)
- **ليه كل الحقول دي؟** لو الضريبة اتغيرت بعد سنتين، الفاتورة القديمة تفضل صحيحة — الأرقام مجمدة في الـ Order

### 3.4 Partial Delivery — Reservation Tracking

- كل `Reservation` مرتبط بـ `SalesOrderItem` (مش بالـ Order كامل)، وكل item ليه Reservation مستقل
- عند Confirm/Approve: `reservedStock += orderedQty` للـ item، وبنشئ Reservation مع `salesOrderItemId`
- عند Deliver:
  - الكمية الموصلة بتخصم من `reservedStock` وبتزود `fulfilledQty` في الـ Reservation
  - الـ Reservation **يفضل Active** طالما `fulfilledQty < orderedQty` (ordered = 100, fulfilled = 30, remaining = 70)
  - Reservation يتقفل بس لما `fulfilledQty >= orderedQty`
- Cancel بعد Partial: `reservedStock -= (orderedQty - deliveredQty)` — مش `orderedQty`
- ده بيسمح بتتبع دقيق: أي reservation اتنفذ قد إيه، وأي جزء لسه متبقي

### 3.5 Approval Entity

- كل طلب محتاج اعتماد بيدخل سجل جديد في `SalesOrderApproval`
- القيم: `status = pending` | `approved` | `rejected`
- لو `grandTotal > threshold` عند Confirm: بيتخلق `SalesOrderApproval(pending)`
- الـ Owner يعمل `approve` → `SalesOrderApproval(status=approved, approvedBy, approvedAt)` + Confirm الفعلي + Reserve
- الـ Owner يعمل `reject` → `SalesOrderApproval(status=rejected, rejectedBy, rejectedAt, reason)`
- لو الطلب اتعدل واتحاول Confirm تاني → Approval جديد (تاريخ كامل لكل محاولة)
- الـ Manager مش قادر يعدل الـ Approvals خالص (صلاحية `approve`/`reject` لـ Owner بس)
- قابل للتوسع مستقبلًا: موافقة مدير مالي، موافقة إدارة — من غير ما نكسر الـ Schema

### 3.6 Audit Snapshots

- `SalesOrderStatusHistory.beforeState`: JSON للـ Order كامل قبل الـ transition
- `SalesOrderStatusHistory.afterState`: JSON للـ Order كامل بعد الـ transition
- `SalesOrderStatusHistory.changedFields`: `["status", "approvedBy"]` — القراءة السريعة
- بيسمح بعمل مقارنة دقيقة: إيه اللي اتغير بالظبط

### 3.8 Schema Tests (Phase 2)

قبل أي Backend أو Permissions، نكتب اختبارات للـ Schema نفسه:

| Test | What it verifies |
|------|-----------------|
| Migration Up | إن الـ migration الجديد يشتغل من غير أخطار على Database فاضية |
| Foreign Keys | `SalesOrder.clientId → Client.id`، `SalesOrderItem.productId → Product.id`، `SalesDelivery.salesOrderId → SalesOrder.id`، `SalesOrderApproval.salesOrderId → SalesOrder.id` |
| Unique Constraints | `SalesOrder.orderNumber`، `SalesDelivery.deliveryNumber` |
| Indexes | Composite indexes: `(status, createdAt)`، `(clientId, createdAt)`، `(orderNumber)` |
| Default Values | `SalesOrder.status = "draft"`، `SalesOrder.version = 1`، `Product.unit = "قطعة"`، `Notification.priority = "normal"` |
| Required Fields | إن `clientId` و `items` مطلوبين في `SalesOrder` |
| Cascade Delete | `SalesOrderItem` يتحدف لما `SalesOrder` يتحدف (onDelete: Cascade) |
| Soft Delete | `deletedAt` + `deletedBy` موجودين، ومفيش `isDeleted` خالص |

**الهدف:** التأكد إن الـ Schema نفسه صحيح قبل ما نكتب أي business logic فوقيه.

### 3.9 Order Number Format

**Sales Orders:**
- الصيغة: `SO-YYYYMM-NNNNNN`
- مثال: `SO-202607-000001`
- الترقيم شهري (يعيد من 1 كل شهر جديد)
- يتحقق من uniqueness في نطاق الشهر (يجيب آخر رقم في الشهر الحالي ويزيد 1)

**Deliveries:**
- الصيغة: `SD-YYYYMM-NNNNNN`
- مثال: `SD-202607-000001`
- نفس منطق الترقيم الشهري

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
  - لو `grandTotal ≤ approvalThresholdValue` (من `SystemSettings`, بالعملة `approvalThresholdCurrency`) → Confirm عادي: `status = confirmed`, Reserve
  - لو `grandTotal > approvalThresholdValue` → `SalesOrderApproval(status=pending)`, `status` يفضل `draft`, Notification للمالك. **مفيش Reserve**
- الـ `approve`: Owner بس. بيحول `status = confirmed` ويعمل Reserve ويسجل costPrice Snapshot + بيقفل الـ `SalesOrderApproval(status=approved)`
- الـ `reject`: Owner بس. `SalesOrderApproval(status=rejected, reason)`, Notification للمنشئ
- لو في Approval مرفوض → ممنوع الـ Confirm. يقدر المنشئ يعدل الطلب ويعمل Confirm تاني (بيتخلق Approval جديد)
- قبل `deliver`: لو في Approval pending نشط → 403 لأي دور

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
| POST | `/api/sales-orders/:id/approve` | approve | P4 | Body: { note? }; ينشئ SalesOrderApproval(status=approved) + Confirm |
| POST | `/api/sales-orders/:id/reject` | reject | P4 | Body: { reason }; ينشئ SalesOrderApproval(status=rejected) |
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
  version: 1;                    // Optimistic Locking — بيرجع لكل الـ POST
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
    sellingPrice: number;        // مجمد
    costPrice: number;           // Moving Average — مجمد عند Confirm/Approve
    taxRate: number;             // مجمد
    discountRate: number;        // مجمد
    currency: string;            // مجمد
    exchangeRate: number;        // مجمد
    totalPrice: number;
  }>;
  subtotal: number;
  grandTotal: number;
  updatedAt: string;             // آخر تحديث
  statusHistory: Array<{ toStatus: string; createdAt: string }>;
}
```

**قاعدة:** كل POST بيستجيب بـ `{ id, status, version, updatedAt }` كحد أدنى — عشان الـ Frontend يعمل Refresh ذكي من غير ما يسأل الـ API تاني.

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
  version: number;
  approvals: Array<{ id: string; status: "approved"; approvedBy: string; approvedAt: string; reason: string }>;
  updatedAt: string;
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
  version: number;
  approvals: Array<{ id: string; status: "rejected"; rejectedBy: string; rejectedAt: string; reason: string }>;
  updatedAt: string;
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
  cursor?: string;   // ➕ Cursor للتارجت السريع على نطاق كبير
}
```

**Cursor Pagination (جاهز لمستقبل كبير):**
- الوضع الحالي: Offset (`page`/`limit`) — كفاية لحد 100 ألف سجل
- الاستعداد: إضافة `cursor` param في الاستعلام — يجيب السجلات بعد الـ cursor مباشرة
- يستخدم `orderBy: { id: 'asc' }` مع `where: { id: { gt: cursor } }`
- جاهز للتفعيل وقت ما الحجم يكبر — مش محتاج Breaking Change في الـ API

---

## 6. Transactions

| Operation | Tables affected | Transaction | Rollback behavior |
|-----------|---------------|------------|-------------------|
| Confirm (≤ threshold) | SalesOrder (status) + SalesOrderStatusHistory + Product (reservedStock) + Reservation + costPrice Snapshot + Notification + InventoryLog | ✅ `$transaction` | لو فشل الـ reservedStock أو الـ Notification، ميحصلش transition |
| Approve (was pending) | SalesOrder (status → confirmed) + SalesOrderApproval (status → approved) + SalesOrderStatusHistory + Product (reservedStock) + Reservation + costPrice Snapshot + Notification + InventoryLog | ✅ `$transaction` | زي Confirm بالظبط — الـ Reserve بيتعمل هنا مش في Confirm |
| Pending Confirm (> threshold) | SalesOrderApproval (create pending) + SalesOrderStatusHistory + Notification | ✅ `$transaction` | مفيش Reserve لسه — مجرد إشعار |
| Deliver | SalesOrder (status) + SalesOrderStatusHistory + SalesDelivery + SalesDeliveryItem + SalesOrderItem (deliveredQty) + Reservation (fulfilledQty, status) + Product (stock + reservedStock) + InventoryLog | ✅ `$transaction` | لو أي item فشل، الكل يرجع. الـ Reservation يفضل Active لو باقي remaining |
| Cancel (confirmed+) | SalesOrder (status) + SalesOrderStatusHistory + Reservation (status → cancelled) + Product (reservedStock) + InventoryLog | ✅ `$transaction` | لو فشل تحرير المخزون، ميحصلش transition |
| Cancel (draft/pending) | SalesOrder (status) + SalesOrderStatusHistory + SalesOrderApproval (status → cancelled if pending) | ✅ `$transaction` | مجرد تغيير status |
| Reject | SalesOrderApproval (status → rejected) + SalesOrderStatusHistory + Notification | ✅ `$transaction` | كامل |
| Create | SalesOrder + SalesOrderItem (snapshot) + SalesOrderStatusHistory | ❌ عملية واحدة | Create نفسه atomic |

**قاعدة:** كل عملية بتغير أكتر من جدول — ومن ضمنها دايمًا **`InventoryLog`** — لازم تكون جوه `$transaction` مع rollback عند الفشل.

### 6.1 Concurrency (Race Condition Protection) — ⚠️ الأهم

**المشكلة:** لو اتنين ضغطوا Confirm في نفس اللحظة → Double Reserve.

**الحل المزدوج:**

1. **Optimistic Locking (`version` field):**
   - `SalesOrder.version` بيعلى بـ +1 مع كل update
   - أي update بيشمل `WHERE version = :currentVersion`
   - لو النسخة غير متطابقة → `409 Conflict` → الـ Frontend يعمل Refresh

2. **Row Lock جوه الـ Transaction:**
   - وقت الـ Confirm/Approve، نقفل صفوف الـ `Product` المرتبطة بـ `SELECT ... FOR UPDATE`
   - الـ Prisma بيدعم ده عبر `$queryRaw` أو `SELECT ... FOR UPDATE` مع Isolation Level
   - الاتنين Confirm بيوصلوا في نفس اللحظة → الأول يكسب، التاني يستنى ويلاقي المخزون اتخصم → يرفض بـ 409

**مثال (Prisma):**
```typescript
const result = await prisma.$transaction(async (tx) => {
  // قفل صفوف المنتجات
  const products = await tx.$queryRaw`SELECT * FROM "Product" WHERE id IN (${ids}) FOR UPDATE`;
  // فحص المخزون
  // Update reservedStock
  // Update SalesOrder WHERE version = :currentVersion
}, { isolationLevel: 'ReadCommitted' });
```

**الـ GET مش بيقفل حاجة** — القفل بس على الـ write operations.

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
| طلبات في انتظار الاعتماد | SalesOrderApproval | P8 | `COUNT(DISTINCT salesOrderId) WHERE status = 'pending'` |
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

كل Notification فيها:
- `entityType` + `entityId` — عشان الـ Frontend يعرف يفتح أي صفحة بنفسه (لو الـ URL اتغير مفيش مشكلة)
- `actionUrl` — اختياري كاختصار بس، مش الأساس
- `priority` — للترتيب في الـ Notification Center
- `createdBySystem` — للتفريق بين إشعارات النظام والإشعارات المرتبطة بمستخدم

كل Notification بتتنشأ جوه نفس `$transaction` بتاعة العملية الأصلية — لو فشلت العملية، مفيش Notification يتخلق.

---

## 9. Audit

| Data Point | Storage | Detail |
|-----------|---------|--------|
| Status transition | SalesOrderStatusHistory | fromStatus, toStatus, changedBy, createdAt, **ip**, **userAgent** |
| State snapshot | SalesOrderStatusHistory.beforeState / afterState | JSON كامل للطلب قبل وبعد — مقارنة دقيقة |
| Changed fields | SalesOrderStatusHistory.changedFields | `["status", "approvedBy"]` — قراءة أسرع للـ Audit |
| Delivery record | SalesDelivery + SalesDeliveryItem | deliveredBy, driverName, vehicle, proofImage, signature, gpsLocation, quantity لكل item |
| Approval record | SalesOrderApproval (status, requestedBy, approvedBy, rejectedBy, reason, timestamps) | كل مستوى اعتماد مستقل — قابل للتوسع مستقبلًا |
| Product snapshot | SalesOrderItem (productName, productSku, barcode, category, brand, unit, costPrice, sellingPrice, taxRate, discountRate, currency, exchangeRate) | السعر والضريبة والعملة بيتجمدوا كاملين وقت الطلب |

**ممنوع حذف أي من هذه السجلات** — حتى soft delete. هي Append-Only.

---

## 10. Rules Summary

| Rule | Detail | Enforcement |
|------|--------|------------|
| Partial Delivery | كل item عنده deliveredQty منفصلة — لو مش كل items اكتملت → `partially_delivered` | Backend transition logic |
| Order Expiry | Draft/Confirmed orders with `expiresAt < NOW()` → auto-cancel | Daily job OR قبل confirm/process/ship/deliver — **مش قبل GET** |
| Approval Gate Before Reserve | `grandTotal > approvalThresholdValue` → Confirm بيتخلق SalesOrderApproval(pending) بس. Reserve و costPrice Snapshot بيتعملوا بعد Approve فقط | Middleware في route confirm |
| Reserved Stock | Confirm/Approve → `reservedStock += qty`; Deliver → `reservedStock -= deliveredQty`; Cancel → `reservedStock -= (orderedQty - deliveredQty)` | Atomic increment/decrement |
| Price Freeze | costPrice + sellingPrice + taxRate + discountRate + currency + exchangeRate بيتجمدوا وقت Confirm/Approve ومبتتغيرش | Written at confirm/approve time |
| Soft Delete Only | ممنوع DELETE على أي سجل ليه تاريخ حركة — Soft Delete بـ `deletedAt` + `deletedBy` فقط (مفيش `isDeleted`) | DB-level + route check |
| Transaction Safety | كل multi-table operation جوه `$transaction` — ودايمًا تتضمن InventoryLog | Code review rule |
| Notification Consistency | الـ Notifications بتتنشأ جوه نفس transaction بتاعة الحدث | Code review rule |
| Audit Completeness | كل status transition يسجل IP + User Agent + before/after JSON + changedFields | Middleware |
| Cost Price — Moving Average | `costPrice` من moving average لآخر PurchaseOrder معتمد | Snapshot عند Confirm أو Approve — مش وقت الإنشاء |
| No Hard Delete for Orders | ممنوع DELETE على SalesOrder لأي سبب — `deletedAt` فقط | Route-level enforcement |
| Status Machine Locked | ممنوع أي Route يعدّل status مباشرة — كل التحويلات من Service واحدة | Service layer + code review |
| Concurrency Safe | Optimistic Locking (`version`) + Row Lock (`FOR UPDATE`) ضد الـ Double Reserve | Transaction isolation |
| InventoryLog Type Enum | `InventoryLogType` Enum مش String: SALES_ORDER, PURCHASE_ORDER, WITHDRAWAL, RETURN, ADJUSTMENT, ... | Schema level |

---

## 11. Phase 3 — Approval Workflow Hardening (2026-08-09)

> **Scope frozen:** لا تعديل Schema/Migration في هذه المرحلة. `SalesOrderApproval` يبقى الـ source of truth الوحيد لقرارات الاعتماد. لا حقول جديدة على `SalesOrder`.

### 11.1 Re-submit بعد الرفض (Rejected → Edit → Confirm)

| الخطوة | السلوك |
|--------|--------|
| `reject` | `SalesOrderApproval(status=rejected, reason)` — الطلب يفضل `draft` |
| `updateOrder` (تعديل المسودة) | كل الـ approvals ذات الحالة `pending` أو `rejected` بتتوسم `superseded` — **مفيش حذف أبدًا**، الـ history يفضل append-only |
| `confirm` بعد التعديل | آخر قرار `superseded` → يُعاد تقييم الـ threshold من جديد → Approval جديد `pending` |
| `confirm` بدون تعديل | آخر قرار لسه `rejected` → **409 "Order was rejected. Edit the order before confirming again."** |

هذا يحقق: **ممنوع الموافقة على بيانات قديمة** + **ممنوع re-submit بدون تعديل** — القرار القديم يظل موجودًا للـ audit ومُعلَّم إنه لم يعد ساريًا.

### 11.2 Derived Projection — `approvalStatus` / `rejectionNote`

لا توجد أعمدة `approvalStatus` أو `rejectionNote` على `SalesOrder`. تُشتق القيم في الـ service من آخر `SalesOrderApproval` غير الـ `superseded` (مرتبة `createdAt` تنازليًا):

| آخر قرار فعّال | `approvalStatus` | `rejectionNote` |
|----------------|------------------|-----------------|
| لا يوجد (أو الكل `superseded`) | `none` | `null` |
| `pending` | `pending` | `null` |
| `approved` | `approved` | `null` |
| `rejected` | `rejected` | `reason` (أو `null` لو مفيش سبب) |

الحقلان يظهران في استجابات: `create/update/confirm/approve/reject/cancel/transition` + `GET /sales-orders` + `GET /sales-orders/:id` (إضافة additive — لا كسر في الحقول الموجودة).

### 11.3 State Conflicts = 409

| السيناريو | الكود |
|-----------|-------|
| Confirm على طلب مش `draft` (من ضمنها **approve مزدوج**) | `409` (كان `400`) |
| Confirm و Approval لسه `pending` | `409` |
| Confirm و آخر قرار `rejected` (بدون تعديل) | `409` |
| Insufficient stock عند Confirm/Approve | `409` (موجودة) |

### 11.4 الـ Threshold

- القاعدة: `sameCurrency === false || grandTotal > threshold.value` → Approval إجباري.
- **`grandTotal === threshold` → Confirm مباشر** (الشرط هو `>` فقط، مش `>=`).
- **اختلاف العملة → Approval إجباري** حتى لو القيمة الرقمية أقل من الـ threshold.
- `SystemSettings` (`approvalThresholdValue` / `approvalThresholdCurrency`) هي مصدر القيمة. لو سجل مفتقد أو قيمته غير رقمية صالحة → fallback باسم صريح `DEFAULT_APPROVAL_THRESHOLD = { value: 5000, currency: "EGP" }` + `console.warn`. **القيمة `0` محفوظة** (تعني "كل طلب يمر على موافقة").
- `db:seed` يعمل create-if-missing فقط للـ settings — **لا يعيد كتابة** قيمة عدّلها المدير يدويًا.

### 11.5 DoD السبعة (Definitions of Done)

| # | DoD | الضمان |
|---|-----|--------|
| 1 | لا موافقة مزدوجة | approve مزدوج → واحد 200 + الآخر 409 (Row Lock + status re-check) |
| 2 | لا حجز مزدوج | parallel confirm/approve → حجز واحد فقط |
| 3 | لا موافقة على بيانات قديمة | التعديل يوسم الـ approvals بـ `superseded` قبل أي confirm جديد |
| 4 | لا re-submit بدون تعديل | confirm بعد reject (بدون edit) → 409 |
| 5 | لا تغيير سعر/تكلفة بعد التجميد | `costPrice`/`sellingPrice` تُجمد عند confirm/approve وتمنع الـ edit بعدها |
| 6 | لا bypass للـ threshold | عملة مختلفة → موافقة إجبارية؛ `=== threshold` → confirm مباشر |
| 7 | لا نقص مخزون وقت الموافقة | approve مع مخزون غير كافٍ → 409 + rollback (الطلب draft + approval pending) |

---

## Appendix: Implementation Phases

| Phase | Scope | Files | Tests |
|-------|-------|-------|-------|
| P0 | Design Freeze | هذا المستند | — |
| P1 | Schema + Migration + Backup | `schema.prisma`, `prisma/migrations/` | — |
| P2 | Schema Tests | `tests/schema/` | ✅ Migration Up, Foreign Keys, Unique Constraints, Indexes, Default Values |
| P3 | Permissions + Seed | `permissions.ts`, `seed.ts` | ✅ تأكيد إن Owner لسه عنده صلاحياته |
| P4 | Backend | `sales-orders.ts`, `notifications.ts`, `salesOrderService.ts`, routes | ✅ Backend Integration Tests (شاملة Concurrency tests) |
| P5 | Backend Tests | `tests/sales-orders/` | ✅ Positive + Negative لكل endpoint + Race Condition tests |
| P6 | Frontend API | `api.ts` | — |
| P7 | Frontend | `SalesOrdersPage.tsx`, `App.tsx`, `Layout.tsx` | — |
| P8 | Dashboard | `DashboardPage.tsx`, locales (`ar.ts`, `en.ts`) | — |
| P9 | Documentation | README, API docs, permissions doc | ✅ توثيق كامل |
| P10 | Executive Report | `docs/reports/YYYY-MM-DD-sales-orders-v2.html` | ✅ تقرير تنفيذي للمدير |

---

*End of Design Freeze Document. Any change requires explicit approval.*
