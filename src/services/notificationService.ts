import { Prisma, PrismaClient } from "@prisma/client";

type Tx = Prisma.TransactionClient;

export type NotificationDb = Tx | PrismaClient;

export type NotificationCategory =
  | "stock"
  | "reorder"
  | "pricing"
  | "returns"
  | "orders"
  | "quarantine"
  | "anomalies"
  | string;

export type NotificationSeverity = "low" | "normal" | "high" | "critical" | string;

export interface NotificationData {
  type: string;
  title: string;
  message: string;
  entityType?: string;
  entityId?: string;
  referenceType?: string;
  referenceId?: string;
  priority?: string;
  icon?: string;
  actionUrl?: string;
  category?: NotificationCategory;
  severity?: NotificationSeverity;
  sourceKey?: string;
}

export interface NotificationInput extends NotificationData {
  /** null = broadcast (system-wide, يظهر في Alerts Center). قيمة = إشعار شخصي. */
  userId?: string | null;
}

// ── Semantic icon per business event (بدل أسماء lucide — بيوحّد التصنيف) ──────
const NOTIFICATION_ICON: Record<string, string> = {
  approval_needed: "approval",
  order_approved: "approval",
  order_rejected: "approval",
  order_confirmed: "approval",
  return_approval_needed: "approval",
  return_approved: "approval",
  return_rejected: "approval",
  order_delivered: "delivery",
  low_stock: "inventory",
  return_created: "return",
  return_received: "return",
  return_refund_pending: "return",
  return_refund_completed: "return",
  return_refund_delayed: "return",
  return_closed: "return",
  return_archived: "return",
  order_expired: "warning",
  reorder_needed: "inventory",
  price_variance: "pricing",
  dead_stock: "inventory",
  quarantine: "warning",
};

function resolveIcon(type: string, explicit?: string): string | undefined {
  return explicit || NOTIFICATION_ICON[type];
}

// ── Build actionUrl from the actual linked entity ────────────────────────────
function buildActionUrl(entityType?: string, entityId?: string): string | undefined {
  if (!entityId) return undefined;
  switch (entityType) {
    case "sales_order":
      return `/sales-orders?focus=${entityId}`;
    case "return_order":
      return `/returns?focus=${entityId}`;
    case "product":
      return `/products?focus=${entityId}`;
    case "purchase_order":
      return `/purchase-orders?focus=${entityId}`;
    case "client":
      return `/clients/${entityId}`;
    case "supplier":
      return `/suppliers/${entityId}`;
    case "warehouse":
      return `/warehouses?focus=${entityId}`;
    default:
      return undefined;
  }
}

export async function createNotification(db: NotificationDb, input: NotificationInput) {
  return db.notification.create({
    data: {
      type: input.type,
      title: input.title,
      message: input.message,
      userId: input.userId || null,
      entityType: input.entityType,
      entityId: input.entityId,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      priority: input.priority || "normal",
      severity: input.severity || "normal",
      icon: resolveIcon(input.type, input.icon),
      actionUrl: input.actionUrl || buildActionUrl(input.entityType, input.entityId),
      category: input.category || null,
      sourceKey: input.sourceKey || null,
      createdBySystem: true,
    },
  });
}

export async function createNotifications(
  db: NotificationDb,
  recipients: Array<string | null | undefined>,
  data: NotificationData
) {
  const unique = new Set(recipients.filter((r): r is string => typeof r === "string" && r.trim().length > 0));
  for (const userId of unique) {
    await createNotification(db, { ...data, userId });
  }
}

// ── إشعار واحد لكل المعنيين (بما فيهم broadcast) مع منع التكرار عبر sourceKey ──
export async function upsertBroadcastNotification(db: NotificationDb, data: NotificationData & { userId?: string | null }) {
  if (!data.sourceKey) {
    return createNotification(db, { ...data, userId: data.userId ?? null });
  }
  const existing = await db.notification.findUnique({ where: { sourceKey: data.sourceKey } });
  if (existing) return existing;
  return createNotification(db, { ...data, userId: data.userId ?? null });
}