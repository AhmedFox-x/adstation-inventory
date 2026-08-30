# ملف الصلاحيات — AD Station Inventory

> مرجع صلاحيات النظام. أي صلاحية جديدة **لازم** تتسجل هنا في نفس مهمة إضافتها (AGENT.md §3.6).

## المنطق الأساسي

- الـ **Database هي مصدر الحقيقة** للصلاحيات (`RoleConfig.permissions`). الكود (`DEFAULT_ROLES` في `src/utils/permissions.ts`) مجرد قالب مبدئي للإنشاء.
- الـ upsert الذكي (`src/utils/seedRoles.ts`) يحدّث **الأدوار النظامية فقط** (`isSystem=true`). أي دور `isSystem=false` (Custom Role) **لا يُلمس إطلاقًا**.
- ممنوع نهائيًا صلاحية `logs.delete` — سجل الحركة Append-Only (AGENT.md §2.1).
- Owner Bypass الدائم **ملغي**. البديل Feature Flag: `PERMISSION_EMERGENCY_BYPASS=true` (مغلق افتراضيًا — لا يُفعَّل في prod).

## الأدوار النظامية

| الدور | `name` | `isSystem` | النطاق |
|-------|--------|-----------|--------|
| المالك | `owner` | true | كل الصلاحيات (`ALL_PERMISSIONS`) |
| مدير | `manager` | true | كل العمليات التشغيلية — بدون إدارة مستخدمين/أدوار وبدون `approve`/`reject` |
| متابع | `viewer` | true | عرض فقط |

## قائمة الصلاحيات الكاملة

### منتجات `products.*`
| الصلاحية | Owner | Manager | Viewer |
|----------|:-----:|:-------:|:------:|
| `products.view` | ✅ | ✅ | ✅ |
| `products.create` | ✅ | ✅ | — |
| `products.edit` | ✅ | ✅ | — |
| `products.delete` | ✅ | ✅ | — |
| `products.setCost` | ✅ | — | — |
| `products.import` | ✅ | — | — |
| `products.export` | ✅ | — | — |

> **`products.setCost`** (مُضافة 2026-08-29): تغيير التكلفة مع مصدر موثّق يغيّر تقييم المخزون — Owner فقط، وقرار أمني تطبيقًا لقاعدة "العمليات عالية الخطورة = صلاحيات منفصلة". ممنوع إعطاؤها لـ manager/viewer.

> ملاحظة تاريخية: `products.import`/`products.export` كانتا في دور manager قبل تحديث 2026-08-02، لكن **لا تُعتمدان** (كانتا محفوظتين في snapshot محلي خارج الـ repo). قرار مالك المشروع: DB = SoT والوضع الحالي (48/41/5) يبقى كما هو.

### تصاريح الصرف والتوريد `permits.*`
| الصلاحية | Owner | Manager | Viewer |
|----------|:-----:|:-------:|:------:|
| `permits.withdraw` | ✅ | ✅ | — |
| `permits.supply` | ✅ | ✅ | — |

### المسح `scan.*`
| الصلاحية | Owner | Manager | Viewer |
|----------|:-----:|:-------:|:------:|
| `scan.use` | ✅ | ✅ | — |

### سجل الحركة `logs.*`
| الصلاحية | Owner | Manager | Viewer |
|----------|:-----:|:-------:|:------:|
| `logs.view` | ✅ | ✅ | ✅ |

> **ممنوع نهائيًا** `logs.delete` — لا في PERMISSIONS ولا في أي دور.

### الجرد `stocktake.*`
| الصلاحية | Owner | Manager | Viewer |
|----------|:-----:|:-------:|:------:|
| `stocktake.create` | ✅ | ✅ | — |
| `stocktake.approve` | ✅ | — | — |

### التقارير `reports.*`
| الصلاحية | Owner | Manager | Viewer |
|----------|:-----:|:-------:|:------:|
| `reports.view` | ✅ | ✅ | ✅ |
| `reports.export` | ✅ | ✅ | ✅ |

### المستخدمون والأدوار
| الصلاحية | Owner | Manager | Viewer |
|----------|:-----:|:-------:|:------:|
| `users.view` | ✅ | — | — |
| `users.manage` | ✅ | — | — |
| `roles.view` | ✅ | — | — |
| `roles.edit` | ✅ | — | — |

### الموردون `suppliers.*`
| الصلاحية | Owner | Manager | Viewer |
|----------|:-----:|:-------:|:------:|
| `suppliers.view` | ✅ | ✅ | — |
| `suppliers.create` | ✅ | ✅ | — |
| `suppliers.edit` | ✅ | ✅ | — |
| `suppliers.delete` | ✅ | ✅ | — |

### أوامر الشراء `purchase_orders.*`
| الصلاحية | Owner | Manager | Viewer |
|----------|:-----:|:-------:|:------:|
| `purchase_orders.view` | ✅ | ✅ | — |
| `purchase_orders.create` | ✅ | ✅ | — |
| `purchase_orders.edit` | ✅ | ✅ | — |
| `purchase_orders.receive` | ✅ | ✅ | — |
| `purchase_orders.submit` | ✅ | ✅ | — |
| `purchase_orders.approve` | ✅ | ✅ | — |
| `purchase_orders.cancel` | ✅ | ✅ | — |
| `purchase_orders.close` | ✅ | ✅ | — |

### العملاء `clients.*`
| الصلاحية | Owner | Manager | Viewer |
|----------|:-----:|:-------:|:------:|
| `clients.view` | ✅ | ✅ | — |
| `clients.create` | ✅ | ✅ | — |
| `clients.edit` | ✅ | ✅ | — |
| `clients.delete` | ✅ | ✅ | — |

### الحجوزات `reservations.*`
| الصلاحية | Owner | Manager | Viewer |
|----------|:-----:|:-------:|:------:|
| `reservations.view` | ✅ | ✅ | — |
| `reservations.create` | ✅ | ✅ | — |
| `reservations.edit` | ✅ | ✅ | — |
| `reservations.cancel` | ✅ | ✅ | — |
| `reservations.fulfill` | ✅ | ✅ | — |

### أوامر البيع `sales_orders.*` (v2 — 11 صلاحيات)
| الصلاحية | Owner | Manager | Viewer | Phase |
|----------|:-----:|:-------:|:------:|:-----:|
| `sales_orders.view` | ✅ | ✅ | ✅ | P3 |
| `sales_orders.create` | ✅ | ✅ | — | P3 |
| `sales_orders.edit_draft` | ✅ | ✅ | — | P3 |
| `sales_orders.confirm` | ✅ | ✅ | — | P3 |
| `sales_orders.process` | ✅ | ✅ | — | P3 |
| `sales_orders.ship` | ✅ | ✅ | — | P3 |
| `sales_orders.deliver` | ✅ | ✅ | — | P3 |
| `sales_orders.approve` | ✅ | — | — | P4 ➕ |
| `sales_orders.reject` | ✅ | — | — | P4 ➕ |
| `sales_orders.close` | ✅ | ✅ | — | P3 |
| `sales_orders.cancel` | ✅ | ✅ | — | P3 |

> **`approve`/`reject` = Owner فقط** — اعتماد الطلبات فوق حد الـ threshold عملية إدارية عليا (AGENT.md §2.2). أُضيفتا في P4 مع الـ Seed للأدوار النظامية في نفس المهمة، واختبارات Positive (Owner 200) + Negative (Manager/Viewer 403).

### المرتجعات `returns.*` (P5 — 7 صلاحيات)
| الصلاحية | Owner | Manager | Viewer | Phase |
|----------|:-----:|:-------:|:------:|:-----:|
| `returns.view` | ✅ | ✅ | ✅ | P5 |
| `returns.create` | ✅ | ✅ | — | P5 |
| `returns.approve` | ✅ | — | — | P5 ➕ |
| `returns.receive` | ✅ | ✅ | — | P5 |
| `returns.reject` | ✅ | — | — | P5 ➕ |
| `returns.close` | ✅ | ✅ | — | P5 |
| `returns.refund` | ✅ | — | — | P5 ➕ |

> **`approve`/`reject`/`refund` = Owner فقط** — اعتماد المرتجع، وإقفاله النهائي، وتسجيل الردّ المالي عمليات إدارية عليا (AGENT.md §2.2)، تمامًا كـ `sales_orders.approve/reject`. أُضيفت في P5 مع الـ Seed للأدوار النظامية في نفس المهمة، واختبارات Positive (Owner 200) + Negative (Manager/Viewer 403) لكل transition حساس.

### قوائم الأسعار `price_lists.*` (Sprint 2 — Batch 1)
| الصلاحية | Owner | Manager | Viewer | الغرض |
|----------|:-----:|:-------:|:------:|:------|
| `price_lists.view` | ✅ | ✅ | ✅ | عرض القوائم وحلّ السعر تلقائيًا |
| `price_lists.manage` | ✅ | ✅ | — | إنشاء/تعديل قائمة وأسعار عناصرها |
| `price_lists.override` | ✅ | ✅ | — | تعديل سعر يدوي في أمر بيع مخالفاً لقائمة العميل |

> **قرار أمني (2026-08-29):** `price_lists.override` اتضافت لـ **Manager** عمدًا — التفاوض على أسعار يومية جزء من عمله التشغيلي، والانحراف عن القائمة بيظهر كـ خصم على الـ item (List Price/Actual/Discount). إعطاؤها لأسعار قريبة من/تحت الـ discount ممكن في Alerts Center. **Owner** يقدر يسحبها من دور Manager في أي وقت من صفحة الأدوار — الملف ده هو المرجع اللي بيسجّل التغيير.

### مركز التنبيهات `alerts.*` (Sprint 2 — Batch 1)
| الصلاحية | Owner | Manager | Viewer | الغرض |
|----------|:-----:|:-------:|:------:|:------|
| `alerts.view` | ✅ | ✅ | ✅ | فتح مركز التنبيهات والفلترة |
| `alerts.manage` | ✅ | ✅ | — | تشغيل الـ sweep، تحديد مقروء/محلول، snooze |

### الكشف عن الحالات الشاذة `anomalies.*` (Sprint 2 — Batch 1)
| الصلاحية | Owner | Manager | Viewer | الغرض |
|----------|:-----:|:-------:|:------:|:------|
| `anomalies.view` | ✅ | ✅ | ✅ | عرض الحالات الشاذة وتفاصيلها |
| `anomalies.run` | ✅ | ✅ | — | تشغيل قواعد الكشف السبع يدويًا |
| `anomalies.resolve` | ✅ | — | — | اعتماد قرار الحالة الشاذة (open→resolved) |

> **`anomalies.resolve` = Owner فقط** — تطبيقًا لقاعدة AGENT.md §2.2: الاعتماد النهائي على خلل (قرار مالي/تشغيلي) يتقيّد بأعلى الدور. Manager يقدر يشغّل الكشف ويشوف، لكن ما يحلش شذوذًا نهائيًا.

### الخط الزمني الموحّد `timeline.*` (Sprint 2 — Batch 1)
| الصلاحية | Owner | Manager | Viewer | الغرض |
|----------|:-----:|:-------:|:------:|:------|
| `timeline.view` | ✅ | ✅ | ✅ | جلب سجل الأحداث الموحّد لأي كيان |

> ملاحظة: `timeline.view` بيعتمد على `logs.view` وREADME للقراءة؛ مطلوب لأنه endpoint تجميعي جديد (تغيير Additive مش Breaking).

## ملخص الأعداد (بعد Batch 1 — Sprint 2)

| الدور | عدد الصلاحيات |
|-------|:------------:|
| owner | 60 |
| manager | 49 |
| viewer | 9 |

> أُضيفت 10 صلاحيات جديدة في Batch 1: `price_lists.view/manage/override` + `alerts.view/manage` + `anomalies.view/run/resolve` + `timeline.view`. Owner = `ALL_PERMISSIONS` (تلقائي). Manager زاد بـ 8 (كلها ما عدا `anomalies.resolve`). Viewer زاد بـ 4 (view بس). بعد تطبيق الـ upsert على prod: owner=60, manager=49, viewer=9.
