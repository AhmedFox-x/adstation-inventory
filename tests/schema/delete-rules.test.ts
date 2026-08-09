import { prisma } from './helpers';
import { cleanDb } from './fixtures';

describe('Delete Rules', () => {
  beforeEach(async () => {
    await cleanDb();
  });

  afterAll(async () => {
    await cleanDb();
  });

  test('CASCADE: حذف SalesOrder بيحذف Items + StatusHistory + Approvals', async () => {
    const client = await prisma.client.create({ data: { name: 'عميل' } });
    const p1 = await prisma.product.create({ data: { name: 'منتج 1', stock: 10 } });
    const p2 = await prisma.product.create({ data: { name: 'منتج 2', stock: 10 } });

    const order = await prisma.salesOrder.create({
      data: {
        orderNumber: `SO-CASC-${Date.now()}`,
        clientId: client.id,
        items: {
          create: [
            { productId: p1.id, orderedQty: 2 },
            { productId: p2.id, orderedQty: 3 },
          ],
        },
        statusHistory: {
          create: [{ toStatus: 'draft', changedBy: 'test' }],
        },
        approvals: {
          create: [{ status: 'pending', requestedBy: 'test' }],
        },
      },
      include: { items: true, approvals: true },
    });

    expect(order.items.length).toBe(2);
    const itemIds = order.items.map((i) => i.id);
    const approvalIds = order.approvals.map((a) => a.id);

    await prisma.salesOrder.delete({ where: { id: order.id } });

    const itemsLeft = await prisma.salesOrderItem.count({ where: { id: { in: itemIds } } });
    const histLeft = await prisma.salesOrderStatusHistory.count({ where: { orderId: order.id } });
    const approvalsLeft = await prisma.salesOrderApproval.count({ where: { id: { in: approvalIds } } });
    expect(itemsLeft).toBe(0);
    expect(histLeft).toBe(0);
    expect(approvalsLeft).toBe(0);
  });

  test('RESTRICT: ممنوع حذف Order ليه Deliveries (SalesDelivery.salesOrderId)', async () => {
    const client = await prisma.client.create({ data: { name: 'عميل' } });
    const order = await prisma.salesOrder.create({
      data: { orderNumber: `SO-REST-${Date.now()}`, clientId: client.id },
    });
    await prisma.salesDelivery.create({
      data: { salesOrderId: order.id, deliveryNumber: `SD-REST-${Date.now()}` },
    });

    await expect(
      prisma.salesOrder.delete({ where: { id: order.id } }),
    ).rejects.toThrow(/foreign key/i);
  });

  test('RESTRICT: ممنوع حذف Product مستخدم في DeliveryItem', async () => {
    const client = await prisma.client.create({ data: { name: 'عميل' } });
    const product = await prisma.product.create({ data: { name: 'منتج', stock: 10 } });
    const order = await prisma.salesOrder.create({
      data: {
        orderNumber: `SO-R2-${Date.now()}`,
        clientId: client.id,
        items: { create: [{ productId: product.id, orderedQty: 2 }] },
      },
      include: { items: true },
    });
    const delivery = await prisma.salesDelivery.create({
      data: { salesOrderId: order.id, deliveryNumber: `SD-R2-${Date.now()}` },
    });
    await prisma.salesDeliveryItem.create({
      data: {
        deliveryId: delivery.id,
        salesOrderItemId: order.items[0].id,
        productId: product.id,
        quantity: 2,
      },
    });

    await expect(
      prisma.product.delete({ where: { id: product.id } }),
    ).rejects.toThrow(/foreign key/i);
  });

  test('RESTRICT: ممنوع حذف Client ليه Orders', async () => {
    const client = await prisma.client.create({ data: { name: 'عميل' } });
    await prisma.salesOrder.create({
      data: { orderNumber: `SO-CL-${Date.now()}`, clientId: client.id },
    });
    await expect(
      prisma.client.delete({ where: { id: client.id } }),
    ).rejects.toThrow(/foreign key/i);
  });

  test('RESTRICT: ممنوع حذف Product عليه Reservations', async () => {
    const product = await prisma.product.create({ data: { name: 'منتج', stock: 10 } });
    await prisma.reservation.create({
      data: { productId: product.id, quantity: 1, createdBy: 't' },
    });
    await expect(
      prisma.product.delete({ where: { id: product.id } }),
    ).rejects.toThrow(/foreign key/i);
  });

  test('SET NULL: حذف SalesOrderItem بيخلي Reservation.salesOrderItemId = NULL', async () => {
    const client = await prisma.client.create({ data: { name: 'عميل' } });
    const product = await prisma.product.create({ data: { name: 'منتج', stock: 10 } });
    const order = await prisma.salesOrder.create({
      data: {
        orderNumber: `SO-SN-${Date.now()}`,
        clientId: client.id,
        items: { create: [{ productId: product.id, orderedQty: 2 }] },
      },
      include: { items: true },
    });

    const reservation = await prisma.reservation.create({
      data: {
        productId: product.id,
        quantity: 2,
        createdBy: 't',
        salesOrderItemId: order.items[0].id,
      },
    });
    expect(reservation.salesOrderItemId).toBe(order.items[0].id);

    await prisma.salesOrderItem.delete({ where: { id: order.items[0].id } });

    const after = await prisma.reservation.findUnique({ where: { id: reservation.id } });
    expect(after!.salesOrderItemId).toBeNull();
  });

  test('CASCADE: حذف SalesDelivery بيحذف Items', async () => {
    const client = await prisma.client.create({ data: { name: 'عميل' } });
    const product = await prisma.product.create({ data: { name: 'منتج', stock: 10 } });
    const order = await prisma.salesOrder.create({
      data: {
        orderNumber: `SO-DC-${Date.now()}`,
        clientId: client.id,
        items: { create: [{ productId: product.id, orderedQty: 2 }] },
      },
      include: { items: true },
    });
    const delivery = await prisma.salesDelivery.create({
      data: { salesOrderId: order.id, deliveryNumber: `SD-DC-${Date.now()}` },
    });
    const di = await prisma.salesDeliveryItem.create({
      data: {
        deliveryId: delivery.id,
        salesOrderItemId: order.items[0].id,
        productId: product.id,
        quantity: 2,
      },
    });

    await prisma.salesDelivery.delete({ where: { id: delivery.id } });
    const left = await prisma.salesDeliveryItem.count({ where: { id: di.id } });
    expect(left).toBe(0);
  });

  test('CASCADE: حذف ReturnOrder بيحذف Items + StatusHistory', async () => {
    const client = await prisma.client.create({ data: { name: 'عميل' } });
    const p1 = await prisma.product.create({ data: { name: 'منتج 1', stock: 10 } });
    const p2 = await prisma.product.create({ data: { name: 'منتج 2', stock: 10 } });
    const order = await prisma.salesOrder.create({
      data: { orderNumber: `SO-RC-${Date.now()}`, clientId: client.id },
    });

    const ret = await prisma.returnOrder.create({
      data: {
        returnNumber: `RT-CASC-${Date.now()}`,
        type: 'customer_return',
        sourceType: 'sales_order',
        sourceId: order.id,
        partyId: client.id,
        partyName: 'عميل',
        items: {
          create: [
            { productId: p1.id, condition: 'new', reason: 'changed_mind', returnedQty: 2 },
            { productId: p2.id, condition: 'damaged', reason: 'damaged', returnedQty: 1 },
          ],
        },
        statusHistory: {
          create: [{ toStatus: 'draft', changedBy: 'test' }],
        },
      },
      include: { items: true, statusHistory: true },
    });

    expect(ret.items.length).toBe(2);
    const itemIds = ret.items.map((i) => i.id);

    await prisma.returnOrder.delete({ where: { id: ret.id } });

    const itemsLeft = await prisma.returnOrderItem.count({ where: { id: { in: itemIds } } });
    const histLeft = await prisma.returnOrderStatusHistory.count({ where: { returnId: ret.id } });
    expect(itemsLeft).toBe(0);
    expect(histLeft).toBe(0);
  });

  test('RESTRICT: ممنوع حذف Product مستخدم في ReturnOrderItem', async () => {
    const client = await prisma.client.create({ data: { name: 'عميل' } });
    const product = await prisma.product.create({ data: { name: 'منتج', stock: 10 } });
    const order = await prisma.salesOrder.create({
      data: { orderNumber: `SO-RR-${Date.now()}`, clientId: client.id },
    });
    await prisma.returnOrder.create({
      data: {
        returnNumber: `RT-REST-${Date.now()}`,
        type: 'customer_return',
        sourceType: 'sales_order',
        sourceId: order.id,
        partyId: client.id,
        partyName: 'عميل',
        items: { create: [{ productId: product.id, condition: 'new', reason: 'changed_mind', returnedQty: 1 }] },
      },
    });

    await expect(
      prisma.product.delete({ where: { id: product.id } }),
    ).rejects.toThrow(/foreign key/i);
  });
});
