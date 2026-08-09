# Returns Management — P0 Design Freeze Document

> **Phase**: P0 — توثيق تصميم نهائي (Design Freeze) قبل أي تنفيذ.
> **النطاق**: إدارة المرتجعات بنوعيها (Customer Return + Supplier Return) بمستوى احتراف مطابق لـ Sales Orders — Status Machine مغلقة، مصادر مقيدة، اعتماد إجباري، معاملات آمنة للـ Race، سجل حركة وتاريخ كامل، إشعارات، لوحة مؤشرات، اختبارات Positive/Negative/Concurrency.
> **تاريخ التحرير**: 2026-08-07
> **المصدر المرجعي**: مواصفات المالك + قرارات محسومة (بند 22).

---

## 0. ملخص تنفيذي

الميزة دي بتحل مشكلة حقيقية: منتج بيرجع من عميل (بسبب عيب أو غلط أو تغيير رأي) أو بيرجع لمورّد (بسبب عيب من المصنع)، وقيمة المخزون والفلوس متأثرة بيه بشكل مباشر. النظام الحالي مفيش فيه أي مسار موثّق للمرتجعات — المرتجع بيتنفّذ "برة النظام" (شيتات ولا رسائل)، فبالتالي:

- المخزون الفعلي بيختلف عن المخزون في النظام (منتج رجع لكن `stock` نقص).
- مفيش سجل تاريخي يثبت مين استلم إيه وإمتى ولييه.
- لو حصل خلاف مع عميل، مفيش مرجع.
- لو منتج تالف رجع، مفيش مكان يتفصل فيه (Quarantine) — ممكن يتعاد البيع بالغلط.

الحل اللي بنبنيه في التصميم ده:

| المشكلة | الحل |
|---|---|
| مرتجع من غير سند | كل مرتجع **ممنوع يكون حر** — مربوط بإجباري بواحد من 4 مصادر: `SalesOrder` / `PurchaseOrder` / `Withdrawal` / `SalesDelivery` |
| الكمية المتسجلة مش مضمونة | الكمية المُرتَجعة على كل بند **محدودة بالكمية المُسلّمة فعلًا** من المصدر (ممنوع أرجع أكتر مما اتسلم) |
| المخزون بيتغير من غير سجل | أي تأثير على المخزون بيتم في **Transaction واحدة** مع `InventoryLog` من نوع `CUSTOMER_RETURN` أو `SUPPLIER_RETURN` |
| التالف ممكن يتعاد بيعه | بند بـ Condition = `damaged` / `needs_inspection` بيودّع الكمية على **`quarantineStock`** وليس `stock` — مفيش مسار يُدخله الـ available stock تلقائيًا |
| مفيش رقابة | **اعتماد إجباري** لكل مرتجع قبل الاستلام (Owner/Admin بس) + Refund بقرار منفصل وصلاحية أعلى + تاريخ كامل لكل حالة |
| صعب نعرف إحنا فين | Dashboard: Return Rate، أكتر منتج/مورّد مرتجع، الأسباب الأكثر شيوعًا، مرتجعات بانتظار الـ Refund |
| الـ Refund متأخر ومحدش واخد باله | `refundDueAt` محسوبة تلقائيًا + إشعار `refund_delayed` لو فات موعدها |

---

## 1. المصطلحات والتعريفات

| المصطلح | التعريف |
|---|---|
| **Return Order (المرتجع)** | السجل الأساسي اللي بيوثّق إرجاع كمية من منتج/منتجات لمصدرها. ليه رقم تسلسلي خاص وحالة وسبب وحالة تخزين. |
| **Customer Return (مرتجع عميل)** | عميل بيرجّع بضاعة اشتريها (مربوط بـ SalesOrder أو Withdrawal أو SalesDelivery). |
| **Supplier Return (مرتجع مورّد)** | إحنا بنرجّع بضاعة لمورّد (مربوط بـ PurchaseOrder) — بتخصم من مخزوننا. |
| **Condition (حالة البند)** | الحالة المادية للمنتج لحظة الاستلام (جديد/مفتوح/مستعمل/تالف/يحتاج فحص) — **على مستوى البند**. |
| **Reason (السبب)** | سبب الإرجاع (عيب/منتج غلط/منتهي/ضمان/تغيير رأي/عيب مصنع/تلف شحن/غير ذلك) — **على مستوى البند**. |
| **Warehouse Destination (وجهة التخزين)** | المكان الفيزيائي اللي بضعة المنتجات المرتجعة: `main` / `returns` / `quarantine`. |
| **quarantineStock** | حقل جديد على `Product` — رصيد المنتجات التالفة/قيد الفحص، لا يُعرض للبيع ولا يُحتسب ضمن الـ available stock. |
| **Refund Status** | حالة الفلوس: `none` / `pending` / `partial` / `completed`. |
| **Resolution (القرار النهائي)** | القرار المعتمد للتعويض: `refund` / `replace` / `repair` / `credit_note`. |
| **Source (المصدر)** | المستند الأصلي اللي المرتجع مربوط بيه. |
| **sourceItemId** | البند الداخلي داخل المصدر (سطر في الـ SO/PO/Withdrawal/Delivery) اللي بيتم إرجاعه. |

---

## 2. Business Workflow

### 2.1 Customer Return (مرتجع عميل)

```
[مصدر: SO تم توصيله / Withdrawal / Delivery]
        │
        ▼
[Create Draft] ──▶ [Approve] ──▶ [Receive] ──▶ [Close]
   returns.create     returns.approve  returns.receive   returns.close
        │                (إجباري)          │
        ▼                                  ▼
   [Rejected] ←──── (رفض مع سبب إلزامي)     [Refund] ──▶ refundStatus
   returns.reject                          returns.refund  none→pending/partial/completed
      (حالة نهائية)                           │
                                             ▼
                                     [Close] ── resolution معتمد
```

### 2.2 Supplier Return (مرتجع مورّد)

```
[مصدر: PurchaseOrder وصل]
        │
        ▼
[Create Draft] ──▶ [Approve] ──▶ [Receive] ──▶ [Close]
   returns.create     returns.approve  returns.receive   returns.close
                                          │  stock -= qty (رجوع للمورّد)
                                          ▼
                                    [Credit Note / Resolution]
```

### 2.3 User Stories

| Actor | Story |
|---|---|
| Manager | ينشئ مرتجع عميل على SO متسلّم، بسطر لكل منتج راجع، ويحدّد condition و reason لكل بند |
| Manager | ينشئ مرتجع مورد على PO وصل، والكمية بتخصم من المخزون عند الاستلام |
| Owner/Admin | يعتمد المرتجع قبل ما يتستلم جوه المخزون (Gate إجباري) |
| Owner/Admin | يرفض المرتجع بذكر سبب إلزامي — الحالة تبقى نهائية `rejected` |
| Manager | يستلم البضاعة الفعلية ويأكد الكميات — هنا بيتم التأثير على المخزون |
| Owner/Admin | يسجّل الـ Refund (حالة + مبلغ + موعد استحقاق) ويسوي التعويض |
| Manager | يقفل المرتجع بعد ما يتحدد الـ Resolution النهائي |
| Viewer | يشوف قائمة المرتجعات وتفاصيلها بس — من غير أي إجراء |

### 2.4 Flow Details (بالتفصيل)

| الخطوة | اللي بيعملها | اللي بيحصل | صلاحية |
|---|---|---|---|
| Create | Manager | اختيار النوع والمصدر + بنود المنتجات بكميات و condition/reason/صور. الحالة: `draft` | `returns.create` |
| Update (تعديل Draft) | Manager | تعديل المرتجع **وهو في `draft` فقط** مع Version Check (ممنوع تعديل بعد الاعتماد). الحالة: `draft` | `returns.create` |
| Approve | Owner/Admin | **إجباري لكل مرتجع** — من غير اعتماد مفيش استلام. الحالة: `draft` → `approved` | `returns.approve` |
| Reject | Owner/Admin | رفض مع **سبب إلزامي**. الحالة: `draft` → `rejected` (نهائية) | `returns.reject` |
| Receive | Manager | تأكيد الكميات المستلمة فعلًا + تأثير المخزون (جدول 5.3) + `InventoryLog`. الحالة: `approved` → `received` | `returns.receive` |
| Refund | Owner/Admin | تسجيل الـ Refund: الحالة (pending/partial/completed) + المبلغ + الملاحظة + حساب `refundDueAt`. **لا يُسجَّل إلا بعد الاستلام.** | `returns.refund` |
| Close | Manager | تعيين الـ `resolution` النهائي + قفل المرتجع. الحالة: `received` → `closed` | `returns.close` |
| Archive | Manager | أرشفة (Soft Delete) **للمرتجعات في `draft` فقط** — مفيش حذف نهائي أبدًا (بند 16). | `returns.create` |

---

## 3. Status Machine المقفولة

### 3.1 الانتقالات القانونية

```
draft     ──▶ approved   (returns.approve)
draft     ──▶ rejected   (returns.reject)
approved  ──▶ received   (returns.receive)
received  ──▶ closed     (returns.close)

closed    ──▶ (لا شيء)
rejected  ──▶ (لا شيء)
```

### 3.2 الخريطة البرمجية (مشابهة لـ `VALID_TRANSITIONS` في salesOrderService)

```ts
export const VALID_TRANSITIONS: Record<string, string[]> = {
  draft:    ["approved", "rejected"],
  approved: ["received"],
  received: ["closed"],
  closed:   [],
  rejected: [],
};
```

### 3.3 قواعد صارمة

| القاعدة | السبب |
|---|---|
| `rejected` حالة **نهائية** — لا تُعاد المحاولة عليها | سجل الرفض يفضل شاهدًا محايدًا على القرار؛ لو المطلوب مرتجع جديد، يُنشأ مرتجع جديد |
| `closed` حالة نهائية — ممنوع تعديل أو إعادة فتح | أي تعديل بعد الإقفال يكسر سلامة السجل المالي |
| أي انتقال بيعملي عبر **الـ map** مش بـ update مباشر على الحالة | منع تخطي مراحل أو قفزات غير قانونية |
| كل انتقال يُسجَّل في `ReturnOrderStatusHistory` مع `beforeState`/`afterState`/`changedFields`/`ip`/`userAgent` | تدقيق كامل (بند 18) |
| كل انتقال يزوّد `version` | كشف أي تعديل متوازٍ (Optimistic Locking على تعديل الدرفت) |

### 3.4 متى يحدث تأثير المخزون؟

**فقط وفقط في خطوة Receive** — لا في الإنشاء ولا في الاعتماد. لو المرتجع اتقفل قبل الاستلام (رفض أو أرشفة)، **لا يحدث أي تأثير على المخزون إطلاقًا**. ده ضمان إن الـ stock بيتغيّر في نقطة واحدة يمكن تدقيقها.

---

## 4. أنواع المرتجعات والمصادر

### 4.1 جدول المصادر المسموحة

| نوع المرتجع (`type`) | المصادر المسموحة (`sourceType`) | بند المصدر المرجعي |
|---|---|---|
| `customer_return` | `sales_order` | `SalesOrderItem` |
| `customer_return` | `withdrawal` | `WithdrawalItem` |
| `customer_return` | `delivery` | `SalesDeliveryItem` |
| `supplier_return` | `purchase_order` | `PurchaseOrderItem` |

### 4.2 قاعدة "ممنوع مرتجع حر" (إلزامية)

1. عند الإنشاء، `sourceType` + `sourceId` **إلزاميان** — لا يوجد أي مسار ينشئ مرتجع بدونهما.
2. السيرفر يتحقق أن المصدر موجود فعلًا وغير محذوف، وكل `productId` في البنود موجودة ضمن بنود المصدر.
3. الكمية المرتجعة لكل منتج **لا تتجاوز الكمية المسلّمة القابلة للإرجاع** من المصدر (جدول 4.3).
4. التحقق من السقف بياخد في الاعتبار **كل المرتجعات السابقة** على نفس المصدر (غير المرفوضة وغير المؤرشفة) — يعني ممنوع إرجاع نفس الكمية مرتين على مرتجعين.

### 4.3 سقف الكمية لكل مصدر

| المصدر | الشرط المسبق | الحد الأقصى لكل منتج |
|---|---|---|
| `sales_order` | الطلب موجود وليس `deletedAt` | مجموع `deliveredQty` في بنود الطلب لنفس المنتج − مجموع ما سبق إرجاعه |
| `withdrawal` | الإذن موجود | مجموع `quantityActual` في بنود الإذن لنفس المنتج − ما سبق إرجاعه |
| `delivery` | التوصيل موجود | مجموع `quantity` في بنود التوصيل لنفس المنتج − ما سبق إرجاعه |
| `purchase_order` | الطلب بحالة `received` | مجموع `receivedQty` في بنود الطلب لنفس المنتج − ما سبق إرجاعه |

> ملاحظة: سقف الكميات بيتحقق في **مرحلتين**: عند الإنشاء (تحقق سريع) وعند الاستلام (تحقق نهائي داخل الـ Transaction مع Row Locks) — بند 17.

### 4.4 ما الذي لا يُسمح به؟

- مرتجع على SO لم يتم توصيل أي بند منه (لا `deliveredQty`).
- مرتجع مورد على PO غير مستلم (`received`).
- مرتجع عميل على PurchaseOrder أو مرتجع مورد على SalesOrder (Cross-type).
- بند غير موجود في المصدر.
- كمية تتجاوز السقف (حتى لو بجزء).
- مرتجعان متوازيان بنفس المنتج والكمية على نفس المصدر (التحقق من المجموع الكلي).

---

## 5. قواعد تأثير المخزون

### 5.1 متغيرات القرار

لكل بند عند الاستلام:
- `type` من الهيدر (`customer_return` / `supplier_return`).
- `condition` من البند.
- `receivedQty` — الكمية المؤكدة الفعلية (<= `returnedQty`).

### 5.2 القاعدة الأساسية

| السيناريو | التأثير على `stock` | التأثير على `quarantineStock` |
|---|---|---|
| Customer Return، condition ∈ {new, opened, used} | **+ receivedQty** | — |
| Customer Return، condition ∈ {damaged, needs_inspection} | — | **+ receivedQty** |
| Supplier Return، أي condition | **− receivedQty** (البضاعة رجعت للمورّد) | — |

### 5.3 جدول مثال توضيحي (من مواصفات المالك)

| المرتجع | البند | condition | التأثير |
|---|---|---|---|
| Customer Return | منتج A، 5 وحدات، بحالة جيدة | `new` | `stock += 5` |
| Supplier Return | منتج B، 17 وحدة | `damaged` | `stock -= 17` |

### 5.4 قواعد إضافية صارمة

1. **كل تغيير على الكميات يتم بـ `increment`/`decrement` atomic** داخل نفس الاستعلام — ممنوع قراءة ثم كتابة في خطوتين (AGENT.md 3.1).
2. `receivedQty` يجب أن يكون `0 <= receivedQty <= returnedQty`.
3. لو `receivedQty == 0` لكل البنود → لا تأثير على المخزون، والحالة بتوصل `received` برصيد صفري (مرتجع "لم يصل فعليًا" — مع حفظه للتدقيق).
4. لو البند `damaged`/`needs_inspection`، الوجهة المسجلة (`warehouseDestination`) يجب أن تكون `quarantine` — ولو غير ذلك، يجب أن تكون `main` أو `returns`. **التحقق عند الإنشاء وعند الاستلام** (بند 9).
5. لا يحدث تأثير إلا في خطوة `receive` داخل `$transaction` مع `lockProducts` (بند 17).
6. `reservedStock` **لا يتأثر** بالمرتجعات أبدًا — الـ reservation يخصّ Sales Orders فقط ولا علاقة له بالإرجاع.

---

## 6. Enums

القيم مخزنة كنصوص (`String`) مطابقة لهذه القيم — نفس أسلوب `SalesOrder.status`.

### 6.1 Return Status

```
draft | approved | received | closed | rejected
```

### 6.2 Return Type

```
customer_return | supplier_return
```

### 6.3 Source Type

```
sales_order | purchase_order | withdrawal | delivery
```

### 6.4 Condition (على مستوى البند)

```
new | opened | used | damaged | needs_inspection
```

### 6.5 Reason (على مستوى البند)

```
damaged | wrong_item | expired | warranty | changed_mind | factory_defect | shipping_damage | other
```

### 6.6 Warehouse Destination

```
main | returns | quarantine
```

### 6.7 Refund Status

```
none | pending | partial | completed
```

### 6.8 Resolution

```
refund | replace | repair | credit_note
```

---

## 7. Schema

### 7.1 قرارات Schema رئيسية

- كل النماذج الجديدة تتبع نفس أسلوب Sales Orders: `id` CUID، تواريخ `createdAt`/`updatedAt`، `version`، `deletedAt`/`deletedBy` للـ Soft Delete.
- لا تُضاف أي قيود `CHECK` إضافية في البداية — القيود تُنفَّذ في طبقة الـ Service داخل المعاملات (نفس أسلوب المشروع الحالي) + تُفحص بواسطة اختبارات schema/unique/required.
- فهارس (Indexes) لكل الحقول المستخدمة في الفلترة والانضمام (status، type، sourceType+sourceId، createdBy، المرتجع/البند).

### 7.2 تعديل `Product` (حقل جديد واحد)

```prisma
model Product {
  // ... الحقول الموجودة
  quarantineStock  Int  @default(0)   // NEW — بضاعة تالفة/قيد الفحص، ليست available
}
```

### 7.3 `ReturnOrder`

```prisma
model ReturnOrder {
  id                String   @id @default(cuid())
  returnNumber      String   @unique
  type              String              // customer_return | supplier_return
  sourceType        String              // sales_order | purchase_order | withdrawal | delivery
  sourceId          String
  sourceNumber      String?             // لقطة عرض: SO-... / PO-... / إلخ
  partyId           String?             // clientId (مرتجع عميل) أو supplierId (مرتجع مورد)
  partyName         String?
  status            String   @default("draft")
  warehouseDestination String @default("returns")   // main | returns | quarantine
  subtotal          Float?   @default(0)
  refundAmount      Float?   @default(0)
  currency          String   @default("EGP")
  notes             String?
  images            Json?               // صور عامة للمرتجع (اختياري): [{id, role, data, mime, note}]

  createdBy         String?
  approvedBy        String?
  approvedAt        DateTime?
  rejectedBy        String?
  rejectedAt        DateTime?
  rejectionReason   String?
  receivedBy        String?
  receivedAt        DateTime?
  closedBy          String?
  closedAt          DateTime?

  refundStatus      String   @default("none")     // none | pending | partial | completed
  refundDate        DateTime?
  refundNote        String?
  refundDueAt       DateTime?                     // يحسب تلقائيًا: refundDate + refundDueDays
  resolution        String?                       // refund | replace | repair | credit_note
  replacementOrderId String?                      // لو resolution = replace

  version           Int      @default(1)
  deletedAt         DateTime?
  deletedBy         String?
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  items        ReturnOrderItem[]
  statusHistory ReturnOrderStatusHistory[]

  @@index([status, createdAt])
  @@index([type])
  @@index([sourceType, sourceId])
  @@index([partyId])
  @@index([createdBy])
}
```

### 7.4 `ReturnOrderItem`

```prisma
model ReturnOrderItem {
  id           String  @id @default(cuid())
  returnId     String
  sourceItemId String?            // البند داخل المصدر (SalesOrderItem/WithdrawalItem/...) — لو متاح
  productId    String
  productName  String?
  productSku   String?
  unit         String?
  condition    String             // new | opened | used | damaged | needs_inspection
  reason       String             // damaged | wrong_item | expired | warranty | changed_mind | factory_defect | shipping_damage | other
  returnedQty  Int
  receivedQty  Int     @default(0)
  unitPrice    Float?  @default(0)
  totalPrice   Float?  @default(0)
  imageBefore  String?            // صورة قبل الاستلام (base64)
  imageAfter   String?            // صورة بعد الفحص (base64)
  notes        String?

  returnOrder ReturnOrder @relation(fields: [returnId], references: [id], onDelete: Cascade)
  product     Product     @relation(fields: [productId], references: [id])

  @@index([returnId])
  @@index([productId])
  @@index([sourceItemId])
}
```

### 7.5 `ReturnOrderStatusHistory` (مطابق تمامًا لـ SalesOrderStatusHistory)

```prisma
model ReturnOrderStatusHistory {
  id           String   @id @default(cuid())
  returnId     String
  fromStatus   String?
  toStatus     String
  changedBy    String?
  note         String?
  ip           String?
  userAgent    String?
  beforeState  Json?
  afterState   Json?
  changedFields String[]
  createdAt    DateTime @default(now())

  returnOrder ReturnOrder @relation(fields: [returnId], references: [id], onDelete: Cascade)

  @@index([returnId, createdAt])
  @@index([returnId])
}
```

### 7.6 العلاقات مع النماذج الموجودة

- `ReturnOrderItem.productId → Product` (علاقة إلزامية — نفس نمط `SalesOrderItem`).
- `ReturnOrder.sourceId` **لا تُنشأ لها Foreign Key حقيقية** (مصدر متعدد الأشكال) — المراجع مُتحقق منها في طبقة الخدمة، لكنها `String` عادية تمامًا مثل `referenceType/referenceId` في `InventoryLog`. هذه نقطة مقصودة ومُوثَّقة.
- لا نضيف `returnOrders[]` إلى `Product` إلا إذا كان التوليد السليم للـ Prisma Client يتطلبها — سيُحدَّد أثناء التنفيذ (نفس طريقة إضافة `salesItems`/`purchaseItems`).

### 7.7 معاملة `InventoryLog` (لا تغيير في الموديل — قيم جديدة فقط)

| الحقل | القيمة الجديدة |
|---|---|
| `type` | `CUSTOMER_RETURN` أو `SUPPLIER_RETURN` |
| `referenceType` | `returns` |
| `referenceId` | `ReturnOrder.id` |

---

## 8. الـ Refund والـ Resolution

### 8.1 تدفق الـ Refund (صلاحية `returns.refund` — Owner/Admin فقط)

1. مسموح فقط على مرتجع بحالة `received` (بعد استلام البضاعة الفعلية — ممنوع تعويض قبل استلام المرتجع).
2. السجل يحدد: `refundStatus` (pending/partial/completed) + `refundAmount` + `refundNote` + `refundDate`.
3. عند `pending`/`partial`، يُحسب `refundDueAt = refundDate + refundDueDays` (من `SystemSettings`, افتراضي 7 أيام).
4. عند `completed`، يُصفّر `refundDueAt` (لا مبرر لتنبيه تأخير).

### 8.2 تدفق الـ Close

1. مسموح فقط على مرتجع بحالة `received`.
2. **الشرط الإلزامي للإقفال: `resolution` يجب أن يكون مضبوطًا** (واحد من `refund | replace | repair | credit_note`).
3. لو `resolution == refund`، يجب أن يكون `refundStatus` مضبوطًا (غير `none`) قبل الإقفال.
4. لو `resolution == replace`، يُفضل تسجيل `replacementOrderId` (SO بديلة) — اختياري لكن موصى به.
5. بعد الإقفال: `closed`, ممنوع أي تعديل أو Refund.

### 8.3 الـ Resolution والقرار النهائي (حالة نهائية لكل مرتجع)

| Resolution | المعنى | متطلبات الإقفال |
|---|---|---|
| `refund` | استرداد نقدي | `refundStatus != none` |
| `replace` | استبدال بمنتج جديد | `replacementOrderId` (اختياري) |
| `repair` | إصلاح داخل الشركة | — |
| `credit_note` | إشعار دائن / رصيد | — |

---

## 9. المخازن والـ Quarantine

### 9.1 القرار المحسوم

لا ننشئ جدول `Warehouses` كامل. نستخدم:
1. حقل `warehouseDestination` (enum) على هيدر المرتجع — تسجيل القرار الفيزيائي.
2. حقل `quarantineStock` على `Product` — الرصيد الفعلي للبضاعة التالفة/قيد الفحص.

### 9.2 قواعد الاتساق (تُفحص في الإنشاء والاستلام معًا)

| `condition` للبند | `warehouseDestination` المسموح |
|---|---|
| `new` / `opened` / `used` | `main` أو `returns` |
| `damaged` / `needs_inspection` | `quarantine` فقط |

لو تعارضت، يرفض السيرفر العملية برسالة واضحة.

### 9.3 معنى الوجهات

| الوجهة | المعنى | التأثير على المخزون |
|---|---|---|
| `main` | رصيد جاهز للبيع مباشرة | `stock += qty` |
| `returns` | منطقة استقبال/فحص قبل قرار إعادة البيع | `stock += qty` (رصيد متاح لكن قرار إعادة البيع مش معلن بعد) |
| `quarantine` | بضاعة تالفة/قيد الفحص — **غير قابلة للبيع** | `quarantineStock += qty` |

> الـ `quarantineStock` بيظهر في Dashboard كمؤشر "حجم البضاعة المحجوزة للفحص" وبيُستثنى من قيمة المخزون القابل للبيع.

---

## 10. سجل الحركة (InventoryLog)

### 10.1 عند كل Receive، لكل بند بكمية مستلمة > 0

| الحقل | Customer Return (سليم) | Customer Return (تالف) | Supplier Return |
|---|---|---|---|
| `type` | `CUSTOMER_RETURN` | `CUSTOMER_RETURN` | `SUPPLIER_RETURN` |
| `change` | `+receivedQty` | `+receivedQty` | `−receivedQty` |
| `oldStock` / `newStock` | stock قبل/بعد | stock (غير متغير) | stock قبل/بعد |
| `clientName` / `salesName` | partyName / المستلم | partyName / المستلم | partyName / المستلم |
| `notes` | "استلام مرتجع {qty} من {product} من {party}" | نفس + " (حالة تالف → حجر)" | "إرجاع {qty} من {product} للمورّد" |
| `referenceType` / `referenceId` | `returns` / return.id | `returns` / return.id | `returns` / return.id |

### 10.2 ممنوع

- مسح أو تعديل أي سجل `InventoryLog` (AGENT.md 2.1 — Append-Only) — لا توجد أي route لذلك.
- تسجيل تأثير مرتجع قبل الاستلام أو بعد الإقفال.

---

## 11. الصلاحيات

### 11.1 صلاحيات جديدة (7)

```
returns.view    — عرض القوائم والتفاصيل ولوحة المؤشرات
returns.create  — إنشاء مرتجع + تعديل الدرفت + أرشفة درفت
returns.approve — اعتماد المرتجع (draft → approved)
returns.receive — استلام البضاعة وتأثير المخزون (approved → received)
returns.reject  — رفض المرتجع بسبب إلزامي (draft → rejected)
returns.close   — إقفال المرتجع (received → closed)
returns.refund  — تسجيل الـ Refund (financial — أعلى الأدوار)
```

### 11.2 مصفوفة الأدوار (Seed يُحدَّث في نفس المهمة — AGENT.md 2.3)

| الصلاحية | owner | manager | viewer |
|---|---|---|---|
| `returns.view` | ✅ | ✅ | ✅ |
| `returns.create` | ✅ | ✅ | — |
| `returns.approve` | ✅ | — | — |
| `returns.receive` | ✅ | ✅ | — |
| `returns.reject` | ✅ | — | — |
| `returns.close` | ✅ | ✅ | — |
| `returns.refund` | ✅ | — | — |

**التبرير (AGENT.md 2.2):**
- التشغيل (create/receive/close) → Manager.
- القرار المالي والأمني النهائي (approve/reject/refund) → Owner/Admin فقط.
- `owner` يستلم الكل تلقائيًا لأنه `ALL_PERMISSIONS`.

### 11.3 قواعد إلزامية

- تحديث `PERMISSIONS` map و`DEFAULT_ROLES` في `src/utils/permissions.ts` + `upsertDefaultRoles` في `src/utils/seedRoles.ts` — في نفس المهمة.
- `ALL_PERMISSIONS` لازم يضم السبعة — والـ seed اللي في `src/index.ts` بياخدها تلقائيًا (owner).
- كل route من Routes بتسخدم `requirePermission` — لا يوجد bypass لأي دور (لا Owner Bypass دائم — `PERMISSION_EMERGENCY_BYPASS` مغلق).

---

## 12. واجهة الـ API

> كل المسارات تحت `/api/inventory/returns` وبتحتاج `requireAuth`.

| Method | Path | الصلاحية | الوصف |
|---|---|---|---|
| GET | `/returns` | `returns.view` | قائمة + فلترة (status, type, search, from, to, page, limit) |
| GET | `/returns/:id` | `returns.view` | تفاصيل كاملة (بنود + تاريخ + منشئ/معتمد/مستلم) |
| POST | `/returns` | `returns.create` | إنشاء مرتجع |
| PUT | `/returns/:id` | `returns.create` | تعديل درفت (مع `expectedVersion`) |
| POST | `/returns/:id/approve` | `returns.approve` | اعتماد |
| POST | `/returns/:id/reject` | `returns.reject` | رفض (سبب إلزامي) |
| POST | `/returns/:id/receive` | `returns.receive` | استلام + تأثير المخزون |
| POST | `/returns/:id/refund` | `returns.refund` | تسجيل Refund |
| POST | `/returns/:id/close` | `returns.close` | إقفال (يتطلب resolution) |
| POST | `/returns/:id/archive` | `returns.create` | أرشفة درفت (Soft Delete) |
| GET | `/returns/sources` | `returns.create` | بنود المصدر المتاحة للإرجاع (للنموذج): `?type=sales_order&id=SO...` |
| GET | `/returns/reports/dashboard` | `returns.view` | مؤشرات لوحة المرتجعات |

### 12.1 مثال إنشاء مرتجع عميل

```json
POST /api/inventory/returns
{
  "type": "customer_return",
  "sourceType": "sales_order",
  "sourceId": "SO-id",
  "warehouseDestination": "main",
  "notes": "مرتجع تليفونات",
  "items": [
    {
      "productId": "p1",
      "condition": "new",
      "reason": "changed_mind",
      "returnedQty": 2,
      "unitPrice": 100,
      "imageBefore": "data:image/jpeg;base64,..."
    }
  ]
}
```

### 12.2 مثال استلام (Receive)

```json
POST /api/inventory/returns/RET-xxx/receive
{
  "items": [
    { "itemId": "ri1", "receivedQty": 2 }
  ]
}
```

### 12.3 مثال Refund

```json
POST /api/inventory/returns/RET-xxx/refund
{
  "refundStatus": "completed",
  "refundAmount": 200,
  "refundNote": "تحويل بنكي",
  "refundDate": "2026-08-07"
}
```

### 12.4 مثال Close

```json
POST /api/inventory/returns/RET-xxx/close
{
  "resolution": "refund",
  "replacementOrderId": null
}
```

### 12.5 أرقام المرتجعات

| النوع | البادئة | المثال |
|---|---|---|
| Customer Return | `RT-YYYYMM-NNNNNN` | `RT-202607-000001` |
| Supplier Return | `SR-YYYYMM-NNNNNN` | `SR-202607-000001` |

التوليد داخل الـ Transaction (نفس نمط `generateOrderNumber`) — تسلسل لكل بادئة/شهر.

---

## 13. الربط مع Sales Orders

### 13.1 المطلوب من المالك

- شاشة الـ Sales Order تُظهر للمنتج: `Delivered` و `Returned` و `Net Sold`.

### 13.2 التنفيذ (إضافة غير كاسرة — Additive)

`getOrder` و `listOrders` في `salesOrderService` تُضيف لكل بند (أو في ملخص الرد):

| الحقل الجديد | المعنى | الحساب |
|---|---|---|
| `returnedQty` | الكمية المستلمة من مرتجعات هذا المنتج على نفس الطلب | `SUM(receivedQty)` من `ReturnOrderItem` عبر المرتجعات ذات `sourceType=sales_order` و`sourceId=الطلب` و`status=received/closed` |
| `netSoldQty` | الكمية الصافية المبيعة | `deliveredQty − returnedQty` |

- لا تُعدَّل أي حقول موجودة — الحقول الجديدة تُضاف فقط (AGENT.md 3.3).
- يتم حسابها بطريقة مجمّعة (`groupBy`) لا بطريقة N+1.
- بالنسبة للمصادر الأخرى (Withdrawal/Delivery) تُحسب `returnedQty` بنفس المنطق عند العرض (اختياري في v1).

---

## 14. الإشعارات

| النوع (`type`) | المناسبة | المستلم | الأولوية | الأيقونة |
|---|---|---|---|---|
| `return_created` | تم إنشاء مرتجع جديد | منشئه (تأكيد) | normal | PackagePlus |
| `return_approval_needed` | مرتجع جديد يحتاج اعتماد | كل أصحاب دور owner/Admin | high | ShieldAlert |
| `return_approved` | تم اعتماد المرتجع | المنشئ | normal | BadgeCheck |
| `return_rejected` | تم رفض المرتجع (مع السبب) | المنشئ | urgent | XCircle |
| `return_received` | تم استلام البضاعة وتأثير المخزون | المنشئ + من اعتمد | normal | PackageCheck |
| `return_refund_pending` | تم تسجيل Refund معلّق/جزئي | المنشئ | normal | Banknote |
| `return_refund_completed` | تم استكمال الـ Refund | المنشئ | normal | Banknote |
| `return_closed` | تم إقفال المرتجع | المنشئ | normal | Lock |
| `return_refund_delayed` | فات `refundDueAt` والـ Refund لم يكتمل | أصحاب owner/Admin + المنشئ | urgent | AlarmClock |
| `return_archived` | تمت أرشفة درفت | المنشئ | low | Archive |

> كل الإشعارات `createdBySystem=true` ويتم إنشاؤها داخل نفس الـ Transaction للعملية (لا إشعار بعد Commit منفصل).

---

## 15. لوحة المؤشرات (Dashboard) — `GET /returns/reports/dashboard`

| المؤشر | الحساب | الشكل |
|---|---|---|
| **Return Rate** | `Σ returnedQty / Σ deliveredQty` خلال الفترة (فلترة from/to واختياريًا لكل منتج) | نسبة مئوية |
| **Most Returned Products** | أعلى 5 منتجات بالكمية المرتجعة (customer) | قائمة |
| **Most Returned Suppliers** | أعلى 5 موردين بالكمية/القيمة المرتجعة (supplier) | قائمة |
| **Top Reasons** | توزيع المرتجعات حسب `reason` | عدّادات |
| **Refund Waiting** | مرتجعات `refundStatus ∈ {pending, partial}` — العدد + إجمالي `refundAmount` + أقدم تاريخ | عدّاد + قائمة |
| **By Status** | توزيع المرتجعات الحالية حسب الحالة | عدّادات |
| **By Type** | customer vs supplier | عدّادات |
| **Quarantine Volume** | `Σ quarantineStock` على كل المنتجات + عدد البنود الحالية بحالة تالف | عدّاد |

---

## 16. الحذف والأرشفة (Deletion Policy)

| السيناريو | المسموح |
|---|---|
| مرتجع في `draft` (لم يحدث عليه أي تأثير مخزون) | **Soft Delete** فقط (`archive`) — يُخفى من القوائم مع حفظ السجل والتاريخ كاملًا |
| مرتجع `approved`/`received`/`closed`/`rejected` | **لا حذف ولا أرشفة** — ليه تاريخ حركة فعلي، لازم يفضل ظاهرًا |
| أي سجل بتاريخ حركة | **Hard Delete ممنوع نهائيًا** (AGENT.md 3.4) |
| `ReturnOrderItem` | يتبع الهيدر (Cascade) ولا يوجد أي endpoint حذف مباشر له |

**القواعد الإلزامية:**
- لا يوجد أي route تحذف نهائيًا — النقطة الوحيدة هي `archive` (draft فقط).
- `archive` يسجّل `deletedAt` + `deletedBy` (معرف المستخدم) + إشعار.
- المرتجعات المؤرشفة تُستبعد من كل الفلاتر واللوحات — **باستثناء** مجموع الكميات المُحصَّب على المصدر (سقف الإرجاع) حيث يُستبعد المؤرشف والرفض معًا من الحساب لضمان عدم "أكل" السقف.

---

## 17. المعاملات والـ Concurrency (سلامة البيانات)

### 17.1 العمليات متعددة الجداول كلها داخل `$transaction` واحدة

| العملية | الجداول المتأثرة |
|---|---|
| Create | ReturnOrder + ReturnOrderItem + StatusHistory + (قراءة المصدر للمصادقة) |
| Update (draft) | ReturnOrder + items (delete+create) + StatusHistory + Version |
| Approve | ReturnOrder + StatusHistory + Notification |
| Reject | ReturnOrder + StatusHistory + Notification |
| Receive | ReturnOrder + ReturnOrderItem (receivedQty) + Product (stock/quarantine) + InventoryLog + StatusHistory + Notification |
| Refund | ReturnOrder (refund fields) + StatusHistory + Notification |
| Close | ReturnOrder (resolution/status) + StatusHistory + Notification |
| Archive | ReturnOrder (deletedAt) + StatusHistory + Notification |

> أي فشل في أي جدول = Rollback كامل. لا يوجد سيناريو "المخزون اتخصم والـ Log مسجّلش" (AGENT.md 3.1).

### 17.2 نمط الحماية (مستنسخ من P5 — مُثبَت عمليًا)

```
1. افتح $transaction (timeout 30000)
2. اقرأ المرتجع + المصدر (داخل المعاملة)
3. lockProducts(tx, productIds)           -- SELECT ... FOR UPDATE
4. اقرأ من جديد (fresh) بعد قفل الصفوف     -- يمنع القراءة القديمة
5. تحقق من الحالة القانونية من الـ VALID_TRANSITIONS
6. تحقق من سقف الكميات مقابل المصدر + مجموع المرتجعات السابقة
7. نفّذ تأثير المخزون بـ increment/decrement atomic
8. اكتب InventoryLog + StatusHistory + Notification
9. Commit (أو Rollback تلقائي عند أي throw)
```

### 17.3 السيناريوهات المحمية (Race Conditions)

| السيناريو | النتيجة المتوقعة |
|---|---|
| عمليتا Receive متوازيتان على نفس المرتجع | واحدة تنجح والأخرى ترفض (الحالة أصبحت `received`) — لا تضاعف للمخزون |
| عمليتا Approve متوازيتان | واحدة تنجح والأخرى ترفض |
| عمليتا Refund متوازيتان | واحدة تنجح والأخرى ترفض (استقرار الحالة) |
| مرتجعان متوازيان بنفس المنتج على نفس المصدر | مجموع الكميات المفحوصة على المصدر يمنع تجاوز السقف |
| تعديل درفت مع تعديل آخر | Optimistic Locking: `expectedVersion` → 409 |

---

## 18. الـ Audit الكامل

- كل انتقال حالة → `ReturnOrderStatusHistory` مع:
  - `fromStatus`/`toStatus`/`changedBy`/`note`
  - `beforeState`/`afterState` (JSON) + `changedFields` (قائمة الحقول المتغيرة)
  - `ip` + `userAgent` (من `metaOf(req)`)
- الحقول التالية على الهيدر تُسجّل الفاعل والتوقيت لكل مرحلة:
  `approvedBy/approvedAt`، `rejectedBy/rejectedAt`، `receivedBy/receivedAt`، `closedBy/closedAt`، `deletedBy`.
- لا يوجد مسار لتعديل أو مسح الـ StatusHistory (Append-Only).

---

## 19. نطاق الواجهة الأمامية (Frontend)

### 19.1 صفحات جديدة

| الصفحة | المحتوى |
|---|---|
| `ReturnsPage.tsx` | قائمة المرتجعات (فلترة بالنوع/الحالة/بحث) + تفاصيل + معالجات الإجراءات (approve/reject/receive/refund/close/archive) |
| نموذج إنشاء مرتجع | اختيار النوع → اختيار المصدر (SO/PO/Withdrawal/Delivery) → جلب `GET /returns/sources` → بنود المنتجات بكميات + condition + reason + صور قبل/بعد |

### 19.2 تعديلات

- `SalesOrdersPage.tsx`: إظهار `Returned` و `Net Sold` بجانب `Delivered` لكل بند + زر "إنشاء مرتجع" على الطلب المتسلم.
- `Layout.tsx` + `NotificationsPage.tsx`: دعم إشعارات المرتجعات (`return_*`) — مشكلة في الأيقونات/العناوين الحالية.
- `DashboardPage.tsx`: إضافة كارت "معدل المرتجعات" + "مرتجعات بانتظار الـ Refund".
- `api.ts`: دوال `returnsApi` (list/get/create/update/approve/reject/receive/refund/close/archive/sources/dashboard).
- `i18n/ar.ts` + `en.ts`: مفاتيح `returns.*` + `condition.*` + `reason.*` + `refundStatus.*` + `resolution.*`.
- `PermissionGuard.tsx`: أزرار مشروطة بصلاحيات `returns.*`.

### 19.3 ممنوع

- أي تجاوز للصلاحيات من الواجهة (الزر يظهر/يختفي فقط — الأمان في الـ Backend).
- إرسال أي تأثير مخزون من الواجهة مباشرة (الكلفة والقواعد كلها في الـ Service).

---

## 20. خطة الاختبارات

### 20.1 Suite جديدة: `tests/returns/returnsService.test.ts`

| المجموعة | الحالات |
|---|---|
| **Happy Path — Customer** | create (على SO متسلم) → approve → receive (سليم: stock+ / تالف: quarantine+) → refund → close + تاريخ + إشعارات + InventoryLog |
| **Happy Path — Supplier** | create على PO received → approve → receive (stock−) → close |
| **الحالة السلوكية** | `rejected` نهائية + سبب إلزامي |
| **Negative** | مرتجع حر بدون مصدر مرفوض / كمية > السقف مرفوضة / مصدر غير مسموح / condition≠quarantine مع damaged مرفوض / انتقالات غير قانونية |
| **Concurrency** | Receive متوازيان → تأثير واحد فقط / Refund متوازيان / مرتجعان فوق السقف |
| **Refund Delay** | `refundDueAt` محسوب + إشعار `return_refund_delayed` بعد الموعد |

### 20.2 Suite الصلاحيات (Positive + Negative معًا — AGENT.md 2.4)

- **Positive**: owner يعتمد/يرفض/يسجّل Refund (200)، manager ينشئ/يستلم/يقفل (200).
- **Negative**: manager لا يملك `returns.approve`/`returns.reject`/`returns.refund` (403)، viewer لا يملك حتى `returns.create` (403) لكن `returns.view` (200).
- تحديث `tests/permissions/permissions.test.ts`: التحقق أن `ALL_PERMISSIONS` يضم السبعة + مصفوفة الأدوار مطابقة (مثل بند 11.2).

### 20.3 اختبارات Schema

- `tests/schema/defaults.test.ts`: القيم الافتراضية للنماذج الجديدة.
- `tests/schema/foreign-keys.test.ts` / `unique.test.ts` / `indexes.test.ts` / `required.test.ts`: النماذج الجديدة.
- `tests/schema/delete-rules.test.ts`: لا Hard Delete.
- `tests/schema/drift.test.ts`: schema ⇄ DB مطابقة بعد الـ migration.

### 20.4 معيار النجاح

- السويت الكامل يمر `99 + جديد` بدون فشل.
- لا قفل/Deadlock في عمليات الـ concurrency.

### 20.5 قائمة الأخطاء (Error Catalog) — رسائل موحّدة

> كل الأخطاء تُرمى كـ `ReturnError extends Error` مع `status` (مثل `SalesOrderError`).

| الكود/الحالة | الرسالة (مثال) | المناسبة |
|---|---|---|
| `400` | `Return type is required` | إنشاء بدون `type` صحيح |
| `400` | `sourceType and sourceId are required` | مرتجع حر (ممنوع) |
| `400` | `Source must be a delivered SalesOrder` | SO غير متسلم |
| `400` | `Purchase order must be received` | PO غير مستلم |
| `400` | `Product {name} is not part of the source` | بند غير موجود في المصدر |
| `409` | `Cannot return more than delivered ({max} available)` | تجاوز سقف الكمية |
| `400` | `Damaged items must go to quarantine` | `damaged` مع وجهة غير `quarantine` |
| `400` | `Item {id} not found in return` | بند غير موجود في المرتجع |
| `400` | `receivedQty must be between 0 and returnedQty` | كمية استلام غير صالحة |
| `400` | `Cannot transition from {from} to {to}` | انتقال غير قانوني |
| `404` | `Return not found` | ID غير موجود/مؤرشف |
| `409` | `Return was modified by another user` | Version mismatch |
| `400` | `reason is required` | رفض بدون سبب |
| `400` | `Refund requires received status` | Refund قبل الاستلام |
| `400` | `resolution is required to close` | إقفال بدون Resolution |
| `400` | `Refund status must be set before closing a refund resolution` | إقفال بـ resolution=refund بدون Refund |
| `400` | `Only draft returns can be archived` | أرشفة غير درفت |
| `403` | (من `requirePermission`) | لا يملك الصلاحية |

### 20.6 واجهة الخدمة البرمجية (`returnsService.ts`) — التوقيعات

```ts
// إنشاء
export async function createReturn(
  client: PrismaClient,
  input: CreateReturnInput,
  user: ServiceUser,
  meta: RequestMeta = {}
): Promise<ReturnOrderFull>;

// تعديل درفت (Optimistic Locking عبر expectedVersion)
export async function updateReturn(
  client: PrismaClient,
  id: string,
  input: UpdateReturnInput,
  user: ServiceUser,
  meta: RequestMeta = {}
): Promise<ReturnOrderFull>;

// انتقالات الحالة (كلها داخل Transaction مع lockProducts)
export async function approveReturn(client: PrismaClient, id: string, user: ServiceUser, meta: RequestMeta = {}): Promise<ReturnOrderFull>;
export async function rejectReturn(client: PrismaClient, id: string, user: ServiceUser, meta: RequestMeta = {}, reason?: string): Promise<ReturnOrderFull>;
export async function receiveReturn(client: PrismaClient, id: string, input: ReceiveInput, user: ServiceUser, meta: RequestMeta = {}): Promise<ReturnOrderFull>;
export async function refundReturn(client: PrismaClient, id: string, input: RefundInput, user: ServiceUser, meta: RequestMeta = {}): Promise<ReturnOrderFull>;
export async function closeReturn(client: PrismaClient, id: string, input: CloseInput, user: ServiceUser, meta: RequestMeta = {}): Promise<ReturnOrderFull>;
export async function archiveReturn(client: PrismaClient, id: string, user: ServiceUser, meta: RequestMeta = {}): Promise<ReturnOrderFull>;

// قراءة
export async function listReturns(client: PrismaClient, filters: ReturnListFilters): Promise<{ returns: ReturnOrderFull[]; pagination: Pagination }>;
export async function getReturn(client: PrismaClient, id: string): Promise<ReturnOrderFull | null>;

// مصادر النموذج (أي بنود المصدر قابلة للإرجاع + المتبقي بعد المرتجعات السابقة)
export async function getEligibleSourceItems(client: PrismaClient, opts: { type: string; sourceId: string }): Promise<{ source: any; items: EligibleItem[] }>;

// لوحة المؤشرات
export async function getReturnsDashboard(client: PrismaClient, filters: { from?: string; to?: string }): Promise<DashboardResult>;

// كشف تأخير الـ Refund (يُستدعى في الـ refund + alert check)
export async function checkRefundDelays(client: PrismaClient): Promise<number>;

// حساب المجموعات المرجعة على المصدر (تُستخدم داخل salesOrderService)
export async function getReturnedQtyBySource(client: PrismaClient, sourceType: string, sourceId: string): Promise<Map<string, number>>;
```

---

## 21. خطة الهجرة (Migration)

### 21.1 Migration واحدة جديدة (AGENT.md 3.2)

```
prisma migrate dev --name returns_management
```

- لا تعديل على أي migration قديمة.
- الـ SQL الناتج يُراجع يدويًا قبل أي تطبيق على Production.
- تُختبر أولًا على البيئة التجريبية (DB الاختبار) وليس Production.
- Migration غير مدمرة: كلها `CREATE TABLE` + `ALTER TABLE Product ADD COLUMN quarantineStock` + `CREATE INDEX`.

### 21.2 تتابع النشر

```
1. Migration + Seed الصلاحيات (في نفس المهمة)
2. Test suites (تتطلب الـ Migration مطبقة على DB الاختبار)
3. Frontend build
4. Executive Report
```

---

## 22. القرارات المحسومة (بموافقة المالك)

| # | القرار | الاختيار | الأساس |
|---|---|---|---|
| 1 | مستوى الـ Condition/Reason | **على مستوى البند** | المرتجع الواحد ممكن يضم سليم وتالف معًا |
| 2 | نمذجة المخازن | **حقل enum + `quarantineStock` على Product** | لا توسع في النظام كله بموديل Warehouses |
| 3 | سياسة الاعتماد | **إجباري لكل مرتجع** | مطابق لـ Status Machine (Draft→Approved→Received→Closed) |
| 4 | `rejected` حالة نهائية | نعم — لا إعادة محاولة | الحفاظ على السجل كشاهد محايد |
| 5 | تأثير المخزون | فقط في `receive` | نقطة واحدة قابلة للتدقيق |
| 6 | المصادر | SO/PO/Withdrawal/Delivery — لا مرتجع حر | مواصفة المالك |
| 7 | Refund/Resolution | إجراءان منفصلان بصلاحيات مختلفة | AGENT.md 2.2 |
| 8 | الصلاحيات | approve/reject/refund = Owner فقط | مالية/أمنية نهائية |
| 9 | Soft Delete فقط | archive للدرفت فقط | AGENT.md 3.4 |

### 22.1 أسئلة مفتوحة (بلا قرار بعد — خارج نطاق التنفيذ الحالي إن لم يُجب عليها)

| السؤال | الوضع |
|---|---|
| هل الـ `quarantineStock` لازم يدخل في حساب "قيمة المخزون" التقاريرية أم يُستبعد؟ | افتراضيًا يُستبعد من القيمة القابلة للبيع ويظهر منفصلًا — يمكن مراجعته لاحقًا |
| هل المرتجع المأخوذ على `withdrawal` (إذن الصرف القديم) مطلوب في الواجهة في v1 أم Backend فقط؟ | سيُشمل Backend كاملًا + الواجهة لنوعي SO/PO في v1 — يُحدَّد لاحقًا لو احتاج المالك إظهاره |

---

## 23. تسليم المهمة (Deliverables)

- [ ] `docs/design/returns-management-design.md` (هذا الملف)
- [ ] Migration `returns_management` + تحديث `prisma/schema.prisma`
- [ ] `src/utils/permissions.ts` + `src/utils/seedRoles.ts` (7 صلاحيات + مصفوفة أدوار)
- [ ] `src/services/returnsService.ts` (status machine + transactions + locks)
- [ ] `src/routes/returns.ts` + تسجيله في `src/index.ts`
- [ ] ربط `salesOrderService` بحقول `returnedQty`/`netSoldQty`
- [ ] `src/utils/refundChecks.ts` (أو داخل الخدمة) — كشف تأخير الـ Refund
- [ ] `tests/returns/returnsService.test.ts` + تحديث `tests/permissions/permissions.test.ts` + اختبارات schema
- [ ] Frontend: `ReturnsPage.tsx` + تعديلات SO/Dashboard/Notifications/i18n/api
- [ ] `docs/reports/2026-08-07-phase-8-returns-management.html` + تحديث فهرس التقارير
- [ ] تحديث `docs/permissions.md` (توثيق الصلاحيات الجديدة — AGENT.md 3.6)
