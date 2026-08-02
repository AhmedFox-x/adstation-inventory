import { prisma } from './helpers';
import { seedBase, cleanDb } from './fixtures';

describe('Foreign Keys', () => {
  beforeEach(async () => {
    await cleanDb();
  });

  afterAll(async () => {
    await cleanDb();
  });

  test('SalesOrder.clientId → Client.id (موجودة + ترفض عميل غير موجود)', async () => {
    const { clientId } = await seedBase();

    const fk = await prisma.$queryRaw<Array<{ constraint_name: string }>>`
      SELECT tc.constraint_name FROM information_schema.table_constraints tc
      WHERE tc.constraint_type='FOREIGN KEY'
        AND tc.table_name='SalesOrder'
        AND tc.constraint_name='SalesOrder_clientId_fkey'
    `;
    expect(fk.length).toBe(1);

    await expect(
      prisma.salesOrder.create({
        data: { orderNumber: `SO-REJ-${Date.now()}`, clientId: 'nonexistent-client' },
      }),
    ).rejects.toThrow(/foreign key/i);

    expect(clientId).toBeTruthy();
  });

  test('SalesOrderItem.productId → Product.id (ترفض منتج غير موجود)', async () => {
    await seedBase();
    const order = await prisma.salesOrder.findFirst();

    await expect(
      prisma.salesOrderItem.create({
        data: {
          orderId: order!.id,
          productId: 'nonexistent-product',
          orderedQty: 1,
        },
      }),
    ).rejects.toThrow(/foreign key/i);
  });

  test('SalesOrderItem.orderId → SalesOrder.id (ترفض طلب غير موجود)', async () => {
    const { productId } = await seedBase();

    await expect(
      prisma.salesOrderItem.create({
        data: {
          orderId: 'nonexistent-order',
          productId,
          orderedQty: 1,
        },
      }),
    ).rejects.toThrow(/foreign key/i);
  });

  test('SalesDelivery.salesOrderId → SalesOrder.id (ترفض طلب غير موجود)', async () => {
    await expect(
      prisma.salesDelivery.create({
        data: {
          salesOrderId: 'nonexistent-order',
          deliveryNumber: `SD-REJ-${Date.now()}`,
        },
      }),
    ).rejects.toThrow(/foreign key/i);
  });

  test('Reservation.productId → Product.id (ترفض منتج غير موجود)', async () => {
    await expect(
      prisma.reservation.create({
        data: {
          productId: 'nonexistent-product',
          quantity: 1,
          createdBy: 'tester',
        },
      }),
    ).rejects.toThrow(/foreign key/i);
  });

  test('Reservation.salesOrderItemId → SalesOrderItem.id (ترفض item غير موجود)', async () => {
    const { productId } = await seedBase();
    await expect(
      prisma.reservation.create({
        data: {
          productId,
          quantity: 1,
          createdBy: 'tester',
          salesOrderItemId: 'nonexistent-item',
        },
      }),
    ).rejects.toThrow(/foreign key/i);
  });

  test('Notification.userId مش FK (عمود حر مقصود — الإشعارات مش مربوطة بـ User قسريًا)', async () => {
    const fk = await prisma.$queryRaw<Array<{ constraint_name: string }>>`
      SELECT tc.constraint_name FROM information_schema.table_constraints tc
      WHERE tc.constraint_type='FOREIGN KEY'
        AND tc.table_name='Notification'
    `;
    expect(fk.length).toBe(0);

    const notif = await prisma.notification.create({
      data: {
        userId: 'nonexistent-user',
        type: 'order_confirmed',
        title: 't',
        message: 'm',
      },
    });
    expect(notif.userId).toBe('nonexistent-user');
  });

  test('SalesOrderApproval.salesOrderId → SalesOrder.id (ترفض طلب غير موجود)', async () => {
    await expect(
      prisma.salesOrderApproval.create({
        data: { salesOrderId: 'nonexistent-order', status: 'pending' },
      }),
    ).rejects.toThrow(/foreign key/i);
  });

  test('SalesDeliveryItem → delivery/salesOrderItem/product (ترفض علاقات غير موجودة)', async () => {
    const { orderId, orderItemId, productId } = await seedBase();

    const delivery = await prisma.salesDelivery.create({
      data: { salesOrderId: orderId, deliveryNumber: `SD-OK-${Date.now()}` },
    });

    await expect(
      prisma.salesDeliveryItem.create({
        data: {
          deliveryId: 'nonexistent-delivery',
          salesOrderItemId: orderItemId,
          productId,
          quantity: 1,
        },
      }),
    ).rejects.toThrow(/foreign key/i);

    await expect(
      prisma.salesDeliveryItem.create({
        data: {
          deliveryId: delivery.id,
          salesOrderItemId: 'nonexistent-item',
          productId,
          quantity: 1,
        },
      }),
    ).rejects.toThrow(/foreign key/i);
  });
});
