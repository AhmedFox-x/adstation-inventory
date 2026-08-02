import { prisma } from './helpers';

describe('Migration Up — من الصفر', () => {
  test('كل الجداول المتوقعة موجودة بعد التطبيق', async () => {
    const tables = await prisma.$queryRaw<Array<{ tablename: string }>>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public'
    `;
    const names = tables.map((t) => t.tablename).sort();
    const expected = [
      'Client',
      'InventoryLog',
      'Notification',
      'Product',
      'PurchaseOrder',
      'PurchaseOrderItem',
      'PurchaseOrderStatusHistory',
      'Reservation',
      'RoleConfig',
      'SalesDelivery',
      'SalesDeliveryItem',
      'SalesOrder',
      'SalesOrderApproval',
      'SalesOrderItem',
      'SalesOrderStatusHistory',
      'StocktakeItem',
      'StocktakeSession',
      'Supplier',
      'SupplyItem',
      'SupplyPermit',
      'SystemSettings',
      'User',
      'WithdrawalItem',
      'WithdrawalPermit',
      '_prisma_migrations',
    ].sort();

    expect(names).toEqual(expected);
  });

  test('الـ migrations مسجلة كمطبقة في _prisma_migrations', async () => {
    const rows = await prisma.$queryRaw<Array<{ migration_name: string; finished_at: Date | null }>>`
      SELECT migration_name, finished_at FROM _prisma_migrations
    `;
    const applied = rows.filter((r) => r.finished_at !== null).map((r) => r.migration_name);
    expect(applied).toContain('0_init');
    expect(applied).toContain('20260731221214_sales_orders_v2');
  });

  test('مفيش أي migration فاشلة (rolled_back_at NULL)', async () => {
    const rows = await prisma.$queryRaw<Array<{ rolled_back_at: Date | null }>>`
      SELECT rolled_back_at FROM _prisma_migrations
    `;
    for (const r of rows) {
      expect(r.rolled_back_at).toBeNull();
    }
  });
});
