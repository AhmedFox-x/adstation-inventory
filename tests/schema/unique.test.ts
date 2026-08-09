import { prisma } from './helpers';
import { seedBase, cleanDb } from './fixtures';

describe('Unique Constraints', () => {
  beforeEach(async () => {
    await cleanDb();
  });

  afterAll(async () => {
    await cleanDb();
  });

  test('SalesOrder.orderNumber ممنوع يتكرر', async () => {
    const { orderNumber } = await seedBase();
    const { clientId } = await seedBase();

    await expect(
      prisma.salesOrder.create({
        data: { orderNumber, clientId },
      }),
    ).rejects.toThrow(/unique/i);
  });

  test('SalesDelivery.deliveryNumber ممنوع يتكرر', async () => {
    const { orderId } = await seedBase();
    const num = `SD-DUP-${Date.now()}`;

    await prisma.salesDelivery.create({
      data: { salesOrderId: orderId, deliveryNumber: num },
    });

    const order2 = await prisma.salesOrder.create({
      data: { orderNumber: `SO-OTHER-${Date.now()}`, clientId: (await prisma.client.findFirst())!.id },
    });

    await expect(
      prisma.salesDelivery.create({
        data: { salesOrderId: order2.id, deliveryNumber: num },
      }),
    ).rejects.toThrow(/unique/i);
  });

  test('Product.sku ممنوع يتكرر', async () => {
    const sku = `SKU-${Date.now()}`;
    await prisma.product.create({ data: { name: 'أ', sku } });
    await expect(
      prisma.product.create({ data: { name: 'ب', sku } }),
    ).rejects.toThrow(/unique/i);
  });

  test('SystemSettings.key ممنوع يتكرر', async () => {
    await prisma.systemSettings.create({
      data: { key: 'approvalThresholdValue', value: '5000' },
    });
    await expect(
      prisma.systemSettings.create({
        data: { key: 'approvalThresholdValue', value: '6000' },
      }),
    ).rejects.toThrow(/unique/i);
  });

  test('ReturnOrder.returnNumber ممنوع يتكرر', async () => {
    const num = `RT-202608-${String(Date.now()).slice(-6)}`;
    const client = await prisma.client.create({ data: { name: 'عميل' } });
    const order = await prisma.salesOrder.create({
      data: { orderNumber: `SO-RU-${Date.now()}`, clientId: client.id },
    });
    await prisma.returnOrder.create({
      data: {
        returnNumber: num,
        type: 'customer_return',
        sourceType: 'sales_order',
        sourceId: order.id,
        partyId: client.id,
        partyName: 'عميل',
      },
    });
    await expect(
      prisma.returnOrder.create({
        data: {
          returnNumber: num,
          type: 'customer_return',
          sourceType: 'sales_order',
          sourceId: order.id,
          partyId: client.id,
          partyName: 'عميل',
        },
      }),
    ).rejects.toThrow(/unique/i);
  });
});
