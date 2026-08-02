import { prisma } from './helpers';

describe('Composite Indexes — موجودة فعليًا في DB', () => {
  test('كل الـ indexes المتوقعة موجودة', async () => {
    const rows = await prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
    `;
    const names = rows.map((r) => r.indexname).sort();
    const expected = [
      'SalesOrder_status_createdAt_idx',
      'SalesOrder_clientId_createdAt_idx',
      'SalesOrder_orderNumber_idx',
      'SalesOrder_expectedDeliveryDate_idx',
      'SalesOrderItem_productId_idx',
      'SalesOrderItem_orderId_idx',
      'SalesOrderStatusHistory_orderId_createdAt_idx',
      'SalesDelivery_salesOrderId_idx',
      'SalesDelivery_deliveredAt_idx',
      'Notification_userId_isRead_createdAt_idx',
      'SalesOrderApproval_salesOrderId_status_idx',
      'Reservation_salesOrderItemId_idx',
      'SalesDeliveryItem_deliveryId_idx',
      'SystemSettings_key_key',
      'SalesDelivery_deliveryNumber_key',
      'SalesOrder_orderNumber_key',
    ].sort();

    for (const e of expected) {
      expect(names).toContain(e);
    }
  });

  test('الـ composite indexes مركبة فعلًا (أكتر من عمود)', async () => {
    const rows = await prisma.$queryRaw<Array<{ indexname: string; definition: string }>>`
      SELECT indexname, pg_get_indexdef(('"' || indexname || '"')::regclass) AS definition
      FROM pg_indexes
      WHERE schemaname='public'
        AND indexname IN (
          'SalesOrder_status_createdAt_idx',
          'SalesOrder_clientId_createdAt_idx',
          'Notification_userId_isRead_createdAt_idx',
          'SalesOrderApproval_salesOrderId_status_idx',
          'SalesOrderStatusHistory_orderId_createdAt_idx'
        )
    `;
    expect(rows.length).toBe(5);
    for (const r of rows) {
      const cols = r.definition.match(/\(([^)]+)\)/)?.[1];
      const colCount = cols ? cols.split(',').length : 0;
      expect(colCount).toBeGreaterThan(1);
    }
  });

  test('الـ unique indexes فعلًا UNIQUE', async () => {
    const rows = await prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname FROM pg_indexes
      WHERE schemaname='public' AND indexname IN ('SalesOrder_orderNumber_key','SalesDelivery_deliveryNumber_key')
    `;
    expect(rows.length).toBe(2);
  });
});
