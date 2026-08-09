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
| `products.import` | ✅ | — | — |
| `products.export` | ✅ | — | — |

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

## ملخص الأعداد (prod 2026-08-06)

| الدور | عدد الصلاحيات |
|-------|:------------:|
| owner | 50 |
| manager | 41 |
| viewer | 5 |

> أُضيفت صلاحيتا `sales_orders.approve` + `sales_orders.reject` في P4 → owner 48→50 (لأن owner = `ALL_PERMISSIONS`)، manager بقي 41 (approve/reject مش مدرجتين فيه). بعد تطبيق الـ upsert التالي على prod: owner=50، manager=41.
