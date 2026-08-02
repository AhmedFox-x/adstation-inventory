import { prisma } from './helpers';
import { cleanDb } from './fixtures';

describe('Performance Smoke Test — 10,000 Sales Orders', () => {
  beforeAll(async () => {
    await cleanDb();

    const client = await prisma.client.create({ data: { name: 'عميل ضخم' } });
    const products = await Promise.all([
      prisma.product.create({ data: { name: 'P1', stock: 100000 } }),
      prisma.product.create({ data: { name: 'P2', stock: 100000 } }),
      prisma.product.create({ data: { name: 'P3', stock: 100000 } }),
      prisma.product.create({ data: { name: 'P4', stock: 100000 } }),
    ]);

    const BATCH = 1000;
    const TOTAL = 10000;
    let created = 0;

    for (let b = 0; b < TOTAL / BATCH; b++) {
      const orders: Array<{
        orderNumber: string;
        clientId: string;
        status: string;
        grandTotal: number;
      }> = [];
      for (let i = 0; i < BATCH; i++) {
        const n = b * BATCH + i + 1;
        orders.push({
          orderNumber: `SO-PERF-${String(n).padStart(6, '0')}`,
          clientId: client.id,
          status: ['draft', 'confirmed', 'shipped', 'delivered', 'closed'][n % 5],
          grandTotal: n * 100,
        });
      }
      await prisma.salesOrder.createMany({ data: orders.map((o) => ({
        orderNumber: o.orderNumber,
        clientId: o.clientId,
        status: o.status,
        grandTotal: o.grandTotal,
      })) });
      const ids = await prisma.salesOrder.findMany({
        where: { orderNumber: { in: orders.map((o) => o.orderNumber) } },
        select: { id: true },
      });
      await prisma.salesOrderItem.createMany({
        data: ids.flatMap((r, idx) => [
          {
            orderId: r.id,
            productId: products[0].id,
            orderedQty: 1,
            sellingPrice: 100,
            productName: 'P1',
          },
          {
            orderId: r.id,
            productId: products[idx % 4].id,
            orderedQty: 2,
            sellingPrice: 50,
            productName: `P${(idx % 4) + 1}`,
          },
        ]),
      });
      created += BATCH;
    }

    expect(created).toBe(TOTAL);
    const count = await prisma.salesOrder.count();
    expect(count).toBe(TOTAL);
  }, 300000);

  afterAll(async () => {
    await cleanDb();
  }, 300000);

  test('استعلام بفلتر status + createdAt (يستخدم composite index)', async () => {
    const start = Date.now();
    const rows = await prisma.salesOrder.findMany({
      where: { status: 'shipped' },
      select: { id: true, orderNumber: true, grandTotal: true },
      take: 100,
    });
    const elapsed = Date.now() - start;

    expect(rows.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(5000);
  });

  test('استعلام بفلتر clientId + createdAt (يستخدم composite index)', async () => {
    const client = await prisma.client.findFirst();
    const start = Date.now();
    const rows = await prisma.salesOrder.findMany({
      where: { clientId: client!.id },
      select: { id: true },
      take: 100,
    });
    const elapsed = Date.now() - start;
    expect(rows.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(5000);
  });

  test('استعلام بحث بالـ orderNumber (يستخدم index)', async () => {
    const start = Date.now();
    const row = await prisma.salesOrder.findUnique({
      where: { orderNumber: 'SO-PERF-005000' },
    });
    const elapsed = Date.now() - start;
    expect(row).not.toBeNull();
    expect(elapsed).toBeLessThan(2000);
  });

  test('استعلام Count بمجموع فلاتر (تأكد مفيش بطء)', async () => {
    const start = Date.now();
    const count = await prisma.salesOrder.count({
      where: { status: { in: ['confirmed', 'shipped'] } },
    });
    const elapsed = Date.now() - start;
    expect(count).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(5000);
  });
});
