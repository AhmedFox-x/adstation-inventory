import { Prisma, PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

export interface ResolvedPrice {
  listPrice: number | null;
  tier: string | null;
  listName: string | null;
  source: "customer_specific" | "assigned_list" | "default_list" | "none";
}

// ─────────────────────────────────────────────────────────────────────────────
// حلّ السعر تلقائيًا لعميل + منتج بدلالة قوائم الأسعار.
// ترتيب الأولوية (بموافقة مالك المشروع):
//   1. قائمة عميل خاص (tier=customer + clientId = العميل)
//   2. القائمة المحددة على العميل نفسه (Client.priceListId)
//   3. القائمة الافتراضية النشطة (isDefault=true)
// بدون قائمة → listPrice=null (السلوك القديم: سعر المنتج العادي).
// ─────────────────────────────────────────────────────────────────────────────
export async function resolveClientPrice(
  db: Db,
  clientId: string | null | undefined,
  productId: string
): Promise<ResolvedPrice> {
  async function priceFromList(
    pl: { id: string; name: string; tier: string } | null,
    source: ResolvedPrice["source"]
  ): Promise<ResolvedPrice> {
    if (!pl) return { listPrice: null, tier: null, listName: null, source: "none" };
    const item = await db.priceListItem.findUnique({
      where: { priceListId_productId: { priceListId: pl.id, productId } },
    });
    return { listPrice: item?.price ?? null, tier: pl.tier, listName: pl.name, source };
  }

  if (clientId) {
    // 1) قائمة عميل خاص
    const customerList = await db.priceList.findFirst({
      where: { isActive: true, clientId, tier: "customer" },
      select: { id: true, name: true, tier: true },
    });
    if (customerList) {
      const r = await priceFromList(customerList, "customer_specific");
      if (r.listPrice !== null) return r;
    }

    // 2) القائمة المحددة على العميل
    const client = await db.client.findUnique({
      where: { id: clientId },
      select: { priceListId: true },
    });
    if (client?.priceListId) {
      const assigned = await db.priceList.findFirst({
        where: { id: client.priceListId, isActive: true },
        select: { id: true, name: true, tier: true },
      });
      if (assigned) {
        const r = await priceFromList(assigned, "assigned_list");
        if (r.listPrice !== null) return r;
      }
    }
  }

  // 3) القائمة الافتراضية النشطة
  const def = await db.priceList.findFirst({
    where: { isActive: true, isDefault: true },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, tier: true },
  });
  if (def) {
    const r = await priceFromList(def, "default_list");
    if (r.listPrice !== null) return r;
  }

  return { listPrice: null, tier: null, listName: null, source: "none" };
}

export function hasPriceListPermission(permissions: string[], perm: string): boolean {
  return Array.isArray(permissions) && permissions.includes(perm);
}

// خصم ضمني (نسبة) بين سعر القائمة وسعر البيع الفعلي
export function impliedDiscountPct(listPrice: number | null | undefined, sellingPrice: number | null | undefined): number {
  if (!listPrice || listPrice <= 0 || sellingPrice === null || sellingPrice === undefined) return 0;
  if (sellingPrice >= listPrice) return 0;
  return Math.round(((listPrice - sellingPrice) / listPrice) * 10000) / 100;
}