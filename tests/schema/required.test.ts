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

  test('ReturnOrder بدون returnNumber يفشل (NOT NULL)', async () => {
    const c = await prisma.client.create({ data: { name: 'عميل' } });
    const o = await prisma.salesOrder.create({
      data: { orderNumber: `SO-RQ-${Date.now()}`, clientId: c.id },
    });
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "ReturnOrder" ("id", "type", "sourceType", "sourceId") VALUES ('x8', 'customer_return', 'sales_order', '${o.id}')`,
      ),
    ).rejects.toThrow(/null|returnNumber/i);
  });

  test('ReturnOrderItem بدون productId يفشل (NOT NULL)', async () => {
    const c = await prisma.client.create({ data: { name: 'عميل' } });
    const o = await prisma.salesOrder.create({
      data: { orderNumber: `SO-RQ2-${Date.now()}`, clientId: c.id },
    });
    const r = await prisma.returnOrder.create({
      data: {
        returnNumber: `RT-RQ-${Date.now()}`,
        type: 'customer_return',
        sourceType: 'sales_order',
        sourceId: o.id,
      },
    });
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "ReturnOrderItem" ("id", "returnId", "condition", "reason", "returnedQty") VALUES ('x9', '${r.id}', 'new', 'damaged', 1)`,
      ),
    ).rejects.toThrow(/null|productId/i);
  });

  test('ReturnOrderItem بدون returnedQty يفشل (NOT NULL)', async () => {
    const c = await prisma.client.create({ data: { name: 'عميل' } });
    const p = await prisma.product.create({ data: { name: 'منتج' } });
    const o = await prisma.salesOrder.create({
      data: { orderNumber: `SO-RQ3-${Date.now()}`, clientId: c.id },
    });
    const r = await prisma.returnOrder.create({
      data: {
        returnNumber: `RT-RQ3-${Date.now()}`,
        type: 'customer_return',
        sourceType: 'sales_order',
        sourceId: o.id,
      },
    });
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "ReturnOrderItem" ("id", "returnId", "productId", "condition", "reason") VALUES ('x10', '${r.id}', '${p.id}', 'new', 'damaged')`,
      ),
    ).rejects.toThrow(/null|returnedQty/i);
  });
});
