import { prisma } from './helpers';
import { cleanDb } from './fixtures';

describe('Required Fields — Insert بيعتمد عليهم لازم يفشل (اختبار DB فعلي بـ raw SQL)', () => {
  beforeEach(async () => {
    await cleanDb();
  });

  afterAll(async () => {
    await cleanDb();
  });

  test('SalesOrder بدون clientId يفشل (NOT NULL)', async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "SalesOrder" ("id", "orderNumber") VALUES ('x1', 'SO-REQ-1')`,
      ),
    ).rejects.toThrow(/null|clientId/i);
  });

  test('SalesOrder بدون orderNumber يفشل (NOT NULL)', async () => {
    const c = await prisma.client.create({ data: { name: 'عميل' } });
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "SalesOrder" ("id", "clientId") VALUES ('x2', '${c.id}')`,
      ),
    ).rejects.toThrow(/null|orderNumber/i);
  });

  test('SalesOrderItem بدون productId يفشل (NOT NULL)', async () => {
    const c = await prisma.client.create({ data: { name: 'عميل' } });
    const o = await prisma.salesOrder.create({
      data: { orderNumber: `SO-I-${Date.now()}`, clientId: c.id },
    });
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "SalesOrderItem" ("id", "orderId", "orderedQty") VALUES ('x3', '${o.id}', 1)`,
      ),
    ).rejects.toThrow(/null|productId/i);
  });

  test('SalesOrderItem بدون orderedQty يفشل (NOT NULL)', async () => {
    const c = await prisma.client.create({ data: { name: 'عميل' } });
    const p = await prisma.product.create({ data: { name: 'منتج' } });
    const o = await prisma.salesOrder.create({
      data: { orderNumber: `SO-I2-${Date.now()}`, clientId: c.id },
    });
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "SalesOrderItem" ("id", "orderId", "productId") VALUES ('x4', '${o.id}', '${p.id}')`,
      ),
    ).rejects.toThrow(/null|orderedQty/i);
  });

  test('Notification بدون type يفشل (NOT NULL)', async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "Notification" ("id", "title", "message") VALUES ('x5', 't', 'm')`,
      ),
    ).rejects.toThrow(/null|type/i);
  });

  test('Notification بدون title يفشل (NOT NULL)', async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "Notification" ("id", "type", "message") VALUES ('x6', 'order_confirmed', 'm')`,
      ),
    ).rejects.toThrow(/null|title/i);
  });

  test('SalesDeliveryItem بدون quantity يفشل (NOT NULL)', async () => {
    const c = await prisma.client.create({ data: { name: 'عميل' } });
    const p = await prisma.product.create({ data: { name: 'منتج' } });
    const o = await prisma.salesOrder.create({
      data: {
        orderNumber: `SO-D-${Date.now()}`,
        clientId: c.id,
        items: { create: [{ productId: p.id, orderedQty: 1 }] },
      },
      include: { items: true },
    });
    const d = await prisma.salesDelivery.create({
      data: { salesOrderId: o.id, deliveryNumber: `SD-R-${Date.now()}` },
    });
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "SalesDeliveryItem" ("id", "deliveryId", "salesOrderItemId", "productId") VALUES ('x7', '${d.id}', '${o.items[0].id}', '${p.id}')`,
      ),
    ).rejects.toThrow(/null|quantity/i);
  });
});
