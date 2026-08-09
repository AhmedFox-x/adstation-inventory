import { prisma } from './helpers';
import { cleanDb } from './fixtures';

describe('Default Values', () => {
  beforeEach(async () => {
    await cleanDb();
  });

  afterAll(async () => {
    await cleanDb();
  });

  test('SalesOrder.status ياخد draft افتراضيًا', async () => {
    const client = await prisma.client.create({ data: { name: 'عميل' } });
    const order = await prisma.salesOrder.create({
      data: { orderNumber: `SO-DEF-${Date.now()}`, clientId: client.id },
    });
    expect(order.status).toBe('draft');
  });

  test('SalesOrder.version ياخد 1 افتراضيًا (Optimistic Locking)', async () => {
    const client = await prisma.client.create({ data: { name: 'عميل' } });
    const order = await prisma.salesOrder.create({
      data: { orderNumber: `SO-VER-${Date.now()}`, clientId: client.id },
    });
    expect(order.version).toBe(1);
  });

  test('SalesOrder.createdAt بيتحط تلقائيًا', async () => {
    const client = await prisma.client.create({ data: { name: 'عميل' } });
    const order = await prisma.salesOrder.create({
      data: { orderNumber: `SO-CRE-${Date.now()}`, clientId: client.id },
    });
    expect(order.createdAt).toBeInstanceOf(Date);
    expect(order.createdAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  test('SalesOrderApproval.status ياخد pending افتراضيًا', async () => {
    const client = await prisma.client.create({ data: { name: 'عميل' } });
    const order = await prisma.salesOrder.create({
      data: { orderNumber: `SO-AP-${Date.now()}`, clientId: client.id },
    });
    const approval = await prisma.salesOrderApproval.create({
      data: { salesOrderId: order.id },
    });
    expect(approval.status).toBe('pending');
  });

  test('Product.unit ياخد قطعة افتراضيًا', async () => {
    const product = await prisma.product.create({ data: { name: 'منتج' } });
    expect(product.unit).toBe('قطعة');
  });

  test('Reservation.fulfilledQty ياخد 0 + status active افتراضيًا', async () => {
    const product = await prisma.product.create({ data: { name: 'منتج' } });
    const reservation = await prisma.reservation.create({
      data: { productId: product.id, quantity: 5, createdBy: 'tester' },
    });
    expect(reservation.fulfilledQty).toBe(0);
    expect(reservation.status).toBe('active');
  });

  test('SalesOrderItem.currency EGP + exchangeRate 1 افتراضيًا (Price Freeze)', async () => {
    const client = await prisma.client.create({ data: { name: 'عميل' } });
    const product = await prisma.product.create({ data: { name: 'منتج' } });
    const order = await prisma.salesOrder.create({
      data: {
        orderNumber: `SO-ITEM-${Date.now()}`,
        clientId: client.id,
        items: { create: [{ productId: product.id, orderedQty: 1 }] },
      },
      include: { items: true },
    });
    expect(order.items[0].currency).toBe('EGP');
    expect(order.items[0].exchangeRate).toBe(1);
  });

  test('Notification.isRead false + createdBySystem false + priority normal افتراضيًا', async () => {
    const n = await prisma.notification.create({
      data: { type: 'order_confirmed', title: 't', message: 'm' },
    });
    expect(n.isRead).toBe(false);
    expect(n.createdBySystem).toBe(false);
    expect(n.priority).toBe('normal');
  });

  test('SalesDelivery.deliveredAt بيتحط تلقائيًا', async () => {
    const client = await prisma.client.create({ data: { name: 'عميل' } });
    const order = await prisma.salesOrder.create({
      data: { orderNumber: `SO-DEL-${Date.now()}`, clientId: client.id },
    });
    const delivery = await prisma.salesDelivery.create({
      data: { salesOrderId: order.id, deliveryNumber: `SD-DEF-${Date.now()}` },
    });
    expect(delivery.deliveredAt).toBeInstanceOf(Date);
  });

  test('Product.quarantineStock ياخد 0 افتراضيًا', async () => {
    const product = await prisma.product.create({ data: { name: 'منتج' } });
    expect(product.quarantineStock).toBe(0);
  });

  test('ReturnOrder.status ياخد draft + version 1 + warehouseDestination returns + refundStatus none افتراضيًا', async () => {
    const client = await prisma.client.create({ data: { name: 'عميل' } });
    const order = await prisma.salesOrder.create({
      data: { orderNumber: `SO-RDEF-${Date.now()}`, clientId: client.id },
    });
    const ret = await prisma.returnOrder.create({
      data: {
        returnNumber: `RT-DEF-${Date.now()}`,
        type: 'customer_return',
        sourceType: 'sales_order',
        sourceId: order.id,
      },
    });
    expect(ret.status).toBe('draft');
    expect(ret.version).toBe(1);
    expect(ret.warehouseDestination).toBe('returns');
    expect(ret.refundStatus).toBe('none');
  });

  test('ReturnOrderItem.receivedQty ياخد 0 افتراضيًا', async () => {
    const client = await prisma.client.create({ data: { name: 'عميل' } });
    const product = await prisma.product.create({ data: { name: 'منتج' } });
    const order = await prisma.salesOrder.create({
      data: { orderNumber: `SO-RI-${Date.now()}`, clientId: client.id },
    });
    const ret = await prisma.returnOrder.create({
      data: {
        returnNumber: `RT-RI-${Date.now()}`,
        type: 'customer_return',
        sourceType: 'sales_order',
        sourceId: order.id,
        items: { create: [{ productId: product.id, condition: 'new', reason: 'changed_mind', returnedQty: 2 }] },
      },
      include: { items: true },
    });
    expect(ret.items[0].receivedQty).toBe(0);
  });
});
