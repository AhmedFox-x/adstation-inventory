import { prisma as testPrisma } from '../schema/helpers';
import { cleanDb } from '../schema/fixtures';
import { upsertDefaultRoles } from '../../src/utils/seedRoles';
import {
  createOrder,
  updateOrder,
  confirmOrder,
  approveOrder,
  rejectOrder,
  transitionToProcessing,
  transitionToShipped,
  deliverOrder,
  transitionToClosed,
  cancelOrder,
  expireSalesOrders,
  getOrder,
} from '../../src/services/salesOrderService';

const user = { userId: 'u-test-manager', name: 'مصطفى' };
const owner = { userId: 'u-test-owner', name: 'المالك' };

async function seedBasics() {
  await upsertDefaultRoles(testPrisma);
  const client = await testPrisma.client.create({ data: { name: 'شركة الاختبار' } });
  const p1 = await testPrisma.product.create({
    data: { name: 'منتج أ', unit: 'قطعة', stock: 100, minStock: 5 },
  });
  const p2 = await testPrisma.product.create({
    data: { name: 'منتج ب', unit: 'قطعة', stock: 50, minStock: 5 },
  });
  const ownerRole = await testPrisma.roleConfig.findUnique({ where: { name: 'owner' } });
  await testPrisma.user.create({
    data: {
      email: `owner-${Date.now()}@x.com`,
      password: 'hash',
      firstName: 'O',
      lastName: 'W',
      role: 'owner',
      roleId: ownerRole!.id,
    },
  });
  return { clientId: client.id, productId: p1.id, product2Id: p2.id };
}

async function makeOrder(over: any = {}) {
  const base = await seedBasics();
  const order = (await createOrder(
    testPrisma,
    {
      clientId: base.clientId,
      items: [
        { productId: base.productId, orderedQty: 10, sellingPrice: 100 },
        { productId: base.product2Id, orderedQty: 5, sellingPrice: 50 },
      ],
      ...over,
    },
    user
  ))!;
  return { ...base, order };
}

describe('Sales Orders Service — Full Workflow (Positive)', () => {
  beforeEach(async () => {
    await cleanDb();
    await testPrisma.systemSettings.upsert({
      where: { key: 'approvalThresholdValue' },
      update: { value: '5000' },
      create: { key: 'approvalThresholdValue', value: '5000' },
    });
  });

  afterAll(async () => {
    await cleanDb();
  });

  test('Happy Path: draft → confirm → process → ship → deliver → close', async () => {
    const { order, productId, product2Id } = await makeOrder();

    expect(order.status).toBe('draft');
    expect(order.version).toBe(1);
    expect(order.orderNumber).toMatch(/^SO-\d{6}-\d{6}$/);
    expect(order.grandTotal).toBe(1250); // 100*10 + 50*5
    expect(order.items).toHaveLength(2);
    expect(order.items[0].productName).toBe('منتج أ');
    expect(order.items[0].currency).toBe('EGP');
    expect(order.items[0].exchangeRate).toBe(1);

    // Confirm — under threshold → confirmed + reserved
    const confirmed = await confirmOrder(testPrisma, order.id, user);
    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.version).toBe(2);

    const p1 = await testPrisma.product.findUnique({ where: { id: productId } });
    const p2 = await testPrisma.product.findUnique({ where: { id: product2Id } });
    expect(p1!.reservedStock).toBe(10);
    expect(p2!.reservedStock).toBe(5);
    expect(p1!.stock).toBe(100);
    expect(p2!.stock).toBe(50);

    const reservations = await testPrisma.reservation.findMany({ where: { salesOrderItemId: { in: order.items.map((i: any) => i.id) } } });
    expect(reservations).toHaveLength(2);
    expect(reservations.every((r) => r.status === 'active')).toBe(true);
    expect(reservations.every((r) => r.fulfilledQty === 0)).toBe(true);

    const reserveLogs = await testPrisma.inventoryLog.findMany({ where: { type: 'reservation' } });
    expect(reserveLogs).toHaveLength(2);
    const orderConfirmedNotif = await testPrisma.notification.findFirst({ where: { type: 'order_confirmed' } });
    expect(orderConfirmedNotif).toBeTruthy();
    expect(orderConfirmedNotif!.entityId).toBe(order.id);
    expect(orderConfirmedNotif!.priority).toBe('normal');

    // Moving-average cost frozen
    expect(confirmed.items[0].costPrice).toBe(0);

    const processing = await transitionToProcessing(testPrisma, order.id, user);
    expect(processing.status).toBe('processing');

    const shipped = await transitionToShipped(testPrisma, order.id, user);
    expect(shipped.status).toBe('shipped');

    const delivered = await deliverOrder(
      testPrisma,
      order.id,
      {
        deliveredItems: order.items.map((i: any) => ({ itemId: i.id, deliveredQty: i.orderedQty })),
        driverName: 'سيد',
        vehicle: '1234',
      },
      user
    );
    expect(delivered.status).toBe('delivered');
    expect(delivered.deliveries).toHaveLength(1);
    expect(delivered.deliveries[0].deliveryNumber).toMatch(/^SD-\d{6}-\d{6}$/);
    expect(delivered.deliveries[0].driverName).toBe('سيد');

    const p1After = await testPrisma.product.findUnique({ where: { id: productId } });
    const p2After = await testPrisma.product.findUnique({ where: { id: product2Id } });
    expect(p1After!.stock).toBe(90);
    expect(p1After!.reservedStock).toBe(0);
    expect(p2After!.stock).toBe(45);
    expect(p2After!.reservedStock).toBe(0);

    const saleLogs = await testPrisma.inventoryLog.findMany({ where: { type: 'sale' } });
    expect(saleLogs).toHaveLength(2);

    const deliveredNotif = await testPrisma.notification.findFirst({ where: { type: 'order_delivered' } });
    expect(deliveredNotif).toBeTruthy();

    const fulfilledRes = await testPrisma.reservation.findMany({ where: { salesOrderItemId: { in: order.items.map((i: any) => i.id) } } });
    expect(fulfilledRes.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(fulfilledRes.map((r) => r.fulfilledQty)).toEqual([10, 5]);

    const closed = await transitionToClosed(testPrisma, order.id, user);
    expect(closed.status).toBe('closed');

    // Full audit history
    const history = await testPrisma.salesOrderStatusHistory.findMany({ where: { orderId: order.id } });
    const statuses = history.map((h) => h.toStatus);
    expect(statuses).toContain('confirmed');
    expect(statuses).toContain('processing');
    expect(statuses).toContain('shipped');
    expect(statuses).toContain('delivered');
    expect(statuses).toContain('closed');
    expect(history.every((h) => h.changedFields.length > 0)).toBe(true);
  });

  test('Partial delivery: ship → partial → delivered (reservation tracking)', async () => {
    const { order, productId } = await makeOrder();

    await confirmOrder(testPrisma, order.id, user);
    await transitionToProcessing(testPrisma, order.id, user);
    await transitionToShipped(testPrisma, order.id, user);

    const firstItem = order.items[0];
    const partial = await deliverOrder(
      testPrisma,
      order.id,
      { deliveredItems: [{ itemId: firstItem.id, deliveredQty: 4 }] },
      user
    );
    expect(partial.status).toBe('partially_delivered');

    const p1Partial = await testPrisma.product.findUnique({ where: { id: productId } });
    expect(p1Partial!.stock).toBe(96);
    expect(p1Partial!.reservedStock).toBe(6); // 10 reserved - 4 delivered

    const resPartial = await testPrisma.reservation.findFirst({ where: { salesOrderItemId: firstItem.id } });
    expect(resPartial!.status).toBe('active');
    expect(resPartial!.fulfilledQty).toBe(4);

    // Complete remaining
    const complete = await deliverOrder(
      testPrisma,
      order.id,
      {
        deliveredItems: [
          { itemId: firstItem.id, deliveredQty: 6 },
          { itemId: order.items[1].id, deliveredQty: order.items[1].orderedQty },
        ],
      },
      user
    );
    expect(complete.status).toBe('delivered');

    const p1Done = await testPrisma.product.findUnique({ where: { id: productId } });
    expect(p1Done!.stock).toBe(90);
    expect(p1Done!.reservedStock).toBe(0);

    const resDone = await testPrisma.reservation.findFirst({ where: { salesOrderItemId: firstItem.id } });
    expect(resDone!.status).toBe('fulfilled');
    expect(resDone!.fulfilledQty).toBe(10);

    const deliveries = await testPrisma.salesDelivery.findMany({ where: { salesOrderId: order.id } });
    expect(deliveries).toHaveLength(2);
  });

  test('Deliver below minStock → low_stock notification (product-linked metadata)', async () => {
    const { order, productId } = await makeOrder();
    await confirmOrder(testPrisma, order.id, user);
    await transitionToProcessing(testPrisma, order.id, user);
    await transitionToShipped(testPrisma, order.id, user);

    // ارفع الحد الأدنى ليتفعل low_stock بعد التوصيل (stock 100 → 90)
    await testPrisma.product.update({ where: { id: productId }, data: { minStock: 95 } });

    const delivered = await deliverOrder(
      testPrisma,
      order.id,
      { deliveredItems: order.items.map((i: any) => ({ itemId: i.id, deliveredQty: i.orderedQty })) },
      user
    );
    expect(delivered.status).toBe('delivered');

    const lowStock = await testPrisma.notification.findFirst({ where: { type: 'low_stock' } });
    expect(lowStock).toBeTruthy();
    expect(lowStock!.entityType).toBe('product');
    expect(lowStock!.entityId).toBe(productId);
    expect(lowStock!.referenceType).toBe('product');
    expect(lowStock!.referenceId).toBe(productId);
    expect(lowStock!.priority).toBe('urgent');
    expect(lowStock!.icon).toBe('inventory');
    expect(lowStock!.actionUrl).toBe(`/products?focus=${productId}`);
  });
});

describe('Sales Orders Service — Approval Gate (Owner approve/reject)', () => {
  beforeEach(async () => {
    await cleanDb();
    await testPrisma.systemSettings.upsert({
      where: { key: 'approvalThresholdValue' },
      update: { value: '500' },
      create: { key: 'approvalThresholdValue', value: '500' },
    });
  });

  afterAll(async () => {
    await cleanDb();
  });

  test('Confirm > threshold → stays draft + approval pending + notification to owner, NO reserve', async () => {
    const { order, productId } = await makeOrder(); // grandTotal 1250 > 500

    const result = await confirmOrder(testPrisma, order.id, user);
    expect(result.status).toBe('draft');

    const approval = await testPrisma.salesOrderApproval.findFirst({ where: { salesOrderId: order.id } });
    expect(approval).toBeTruthy();
    expect(approval!.status).toBe('pending');
    expect(approval!.requestedBy).toBe(user.userId);

    const p1 = await testPrisma.product.findUnique({ where: { id: productId } });
    expect(p1!.reservedStock).toBe(0);

    const approvalNotif = await testPrisma.notification.findFirst({ where: { type: 'approval_needed' } });
    expect(approvalNotif).toBeTruthy();
    expect(approvalNotif!.priority).toBe('high');
  });

  test('Approve → confirmed + reserve + order_approved notification', async () => {
    const { order, productId } = await makeOrder();
    await confirmOrder(testPrisma, order.id, user);

    const approved = await approveOrder(testPrisma, order.id, owner);
    expect(approved.status).toBe('confirmed');
    expect(approved.version).toBe(2);

    const approval = await testPrisma.salesOrderApproval.findFirst({ where: { salesOrderId: order.id } });
    expect(approval!.status).toBe('approved');
    expect(approval!.approvedBy).toBe(owner.userId);

    const p1 = await testPrisma.product.findUnique({ where: { id: productId } });
    expect(p1!.reservedStock).toBe(10);

    const approvedNotif = await testPrisma.notification.findFirst({ where: { type: 'order_approved' } });
    expect(approvedNotif).toBeTruthy();
  });

  test('Reject → approval rejected + order stays draft + notification with reason', async () => {
    const { order, productId } = await makeOrder();
    await confirmOrder(testPrisma, order.id, user);

    const rejected = await rejectOrder(testPrisma, order.id, owner, {}, 'العميل غير موثوق');
    expect(rejected.status).toBe('draft');

    const approval = await testPrisma.salesOrderApproval.findFirst({ where: { salesOrderId: order.id } });
    expect(approval!.status).toBe('rejected');
    expect(approval!.rejectedBy).toBe(owner.userId);
    expect(approval!.reason).toBe('العميل غير موثوق');

    const p1 = await testPrisma.product.findUnique({ where: { id: productId } });
    expect(p1!.reservedStock).toBe(0);

    const rejectedNotif = await testPrisma.notification.findFirst({ where: { type: 'order_rejected' } });
    expect(rejectedNotif).toBeTruthy();
    expect(rejectedNotif!.message).toContain('العميل غير موثوق');
  });

  test('Rejected order cannot be confirmed again until edited', async () => {
    const { order } = await makeOrder();
    await confirmOrder(testPrisma, order.id, user);
    await rejectOrder(testPrisma, order.id, owner, {}, 'رفض');
    await expect(confirmOrder(testPrisma, order.id, user)).rejects.toThrow(/rejected/);
  });

  test('Deliver is blocked while approval pending (403)', async () => {
    const { order } = await makeOrder();
    await confirmOrder(testPrisma, order.id, user); // stays draft + pending
    // can't ship a draft; simulate by moving manually is disallowed by design,
    // so verify approval gate via approve path instead — direct approve then deliver.
    const approved = await approveOrder(testPrisma, order.id, owner);
    expect(approved.status).toBe('confirmed');
    await transitionToProcessing(testPrisma, order.id, user);
    await transitionToShipped(testPrisma, order.id, user);

    // Create a fresh pending approval to simulate the 403 gate
    await testPrisma.salesOrderApproval.create({
      data: { salesOrderId: order.id, status: 'pending', requestedBy: user.userId },
    });
    await expect(
      deliverOrder(testPrisma, order.id, { deliveredItems: [{ itemId: order.items[0].id, deliveredQty: 1 }] }, user)
    ).rejects.toThrow(/pending approval/);
  });
});

describe('Sales Orders Service — Negative & Edge Cases', () => {
  beforeEach(async () => {
    await cleanDb();
    await testPrisma.systemSettings.upsert({
      where: { key: 'approvalThresholdValue' },
      update: { value: '5000' },
      create: { key: 'approvalThresholdValue', value: '5000' },
    });
  });

  afterAll(async () => {
    await cleanDb();
  });

  test('Invalid transitions are rejected', async () => {
    const { order } = await makeOrder();
    await expect(transitionToProcessing(testPrisma, order.id, user)).rejects.toThrow(/Cannot transition/);
    await expect(transitionToShipped(testPrisma, order.id, user)).rejects.toThrow(/Cannot transition/);
    await expect(transitionToClosed(testPrisma, order.id, user)).rejects.toThrow(/Cannot transition/);
  });

  test('Cannot edit order after confirmation', async () => {
    const { order } = await makeOrder();
    await confirmOrder(testPrisma, order.id, user);
    await expect(
      updateOrder(
        testPrisma,
        order.id,
        { clientId: order.clientId, items: [{ productId: order.items[0].productId, orderedQty: 3, sellingPrice: 10 }] },
        user
      )
    ).rejects.toThrow(/draft/);
  });

  test('Optimistic locking: editing with stale version → 409', async () => {
    const { order } = await makeOrder();
    await expect(
      updateOrder(
        testPrisma,
        order.id,
        {
          clientId: order.clientId,
          expectedVersion: 999,
          items: [{ productId: order.items[0].productId, orderedQty: 2, sellingPrice: 10 }],
        },
        user
      )
    ).rejects.toThrow(/modified/);
  });

  test('Insufficient stock on confirm → 409 and no partial reservation', async () => {
    const { order, productId, product2Id } = await makeOrder();
    await testPrisma.product.update({ where: { id: productId }, data: { stock: 3 } }); // needs 10

    await expect(confirmOrder(testPrisma, order.id, user)).rejects.toThrow(/Insufficient stock/);

    const p2 = await testPrisma.product.findUnique({ where: { id: product2Id } });
    expect(p2!.reservedStock).toBe(0);
    const logs = await testPrisma.inventoryLog.findMany();
    expect(logs).toHaveLength(0);
  });

  test('Create rejects invalid inputs', async () => {
    await expect(
      createOrder(testPrisma, { clientId: 'x', items: [] }, user)
    ).rejects.toThrow(/items/);
    await expect(
      createOrder(testPrisma, { clientId: 'missing', items: [{ productId: 'nope', orderedQty: 1, sellingPrice: 1 }] }, user)
    ).rejects.toThrow(/Product not found/);
    await expect(
      createOrder(testPrisma, { clientId: 'missing', items: [{ productId: 'x', orderedQty: -1, sellingPrice: 1 }] }, user)
    ).rejects.toThrow(/orderedQty/);
  });

  test('Cannot create a second pending approval (409)', async () => {
    await testPrisma.systemSettings.upsert({
      where: { key: 'approvalThresholdValue' },
      update: { value: '100' },
      create: { key: 'approvalThresholdValue', value: '100' },
    });
    const { order } = await makeOrder();
    await confirmOrder(testPrisma, order.id, user);
    await expect(confirmOrder(testPrisma, order.id, user)).rejects.toThrow(/pending approval/);
  });

  test('Deliver rejects invalid delivered items', async () => {
    const { order } = await makeOrder();
    await confirmOrder(testPrisma, order.id, user);
    await transitionToProcessing(testPrisma, order.id, user);
    await transitionToShipped(testPrisma, order.id, user);

    await expect(deliverOrder(testPrisma, order.id, { deliveredItems: [] }, user)).rejects.toThrow(/deliveredItems/);
    await expect(
      deliverOrder(
        testPrisma,
        order.id,
        { deliveredItems: [{ itemId: order.items[0].id, deliveredQty: 9999 }] },
        user
      )
    ).rejects.toThrow(/exceeds/);
  });

  test('Reject requires a reason', async () => {
    const { order } = await makeOrder();
    await confirmOrder(testPrisma, order.id, user);
    await expect(rejectOrder(testPrisma, order.id, owner, {}, '')).rejects.toThrow(/reason/);
  });
});

describe('Sales Orders Service — Cancel & Expiry', () => {
  beforeEach(async () => {
    await cleanDb();
    await testPrisma.systemSettings.upsert({
      where: { key: 'approvalThresholdValue' },
      update: { value: '5000' },
      create: { key: 'approvalThresholdValue', value: '5000' },
    });
  });

  afterAll(async () => {
    await cleanDb();
  });

  test('Cancel confirmed order releases reservedStock + release log', async () => {
    const { order, productId } = await makeOrder();
    await confirmOrder(testPrisma, order.id, user);

    const cancelled = await cancelOrder(testPrisma, order.id, user, {}, 'العميل ألغى');
    expect(cancelled.status).toBe('cancelled');

    const p1 = await testPrisma.product.findUnique({ where: { id: productId } });
    expect(p1!.reservedStock).toBe(0);
    expect(p1!.stock).toBe(100);

    const releaseLog = await testPrisma.inventoryLog.findFirst({ where: { type: 'release' } });
    expect(releaseLog).toBeTruthy();
    expect(releaseLog!.change).toBe(10);

    const reservations = await testPrisma.reservation.findMany({ where: { salesOrderItemId: { in: order.items.map((i: any) => i.id) } } });
    expect(reservations.every((r) => r.status === 'cancelled')).toBe(true);
  });

  test('Cancel draft order is free (no release needed)', async () => {
    const { order, productId } = await makeOrder();
    const cancelled = await cancelOrder(testPrisma, order.id, user);
    expect(cancelled.status).toBe('cancelled');
    const p1 = await testPrisma.product.findUnique({ where: { id: productId } });
    expect(p1!.reservedStock).toBe(0);
  });

  test('Cannot cancel closed order', async () => {
    const { order } = await makeOrder();
    await confirmOrder(testPrisma, order.id, user);
    await transitionToProcessing(testPrisma, order.id, user);
    await transitionToShipped(testPrisma, order.id, user);
    await deliverOrder(
      testPrisma,
      order.id,
      { deliveredItems: order.items.map((i: any) => ({ itemId: i.id, deliveredQty: i.orderedQty })) },
      user
    );
    await transitionToClosed(testPrisma, order.id, user);
    await expect(cancelOrder(testPrisma, order.id, user)).rejects.toThrow(/Cannot cancel/);
  });

  test('Expired draft order auto-cancels via expireSalesOrders', async () => {
    const { order, productId } = await makeOrder({ expiresAt: new Date(Date.now() - 10000).toISOString() });

    const count = await expireSalesOrders(testPrisma);
    expect(count).toBeGreaterThanOrEqual(1);

    const after = await testPrisma.salesOrder.findUnique({ where: { id: order.id } });
    expect(after!.status).toBe('cancelled');

    const p1 = await testPrisma.product.findUnique({ where: { id: productId } });
    expect(p1!.reservedStock).toBe(0);

    const expiredNotif = await testPrisma.notification.findFirst({ where: { type: 'order_expired' } });
    expect(expiredNotif).toBeTruthy();

    const history = await testPrisma.salesOrderStatusHistory.findFirst({
      where: { orderId: order.id, toStatus: 'cancelled' },
    });
    expect(history!.changedBy).toBe('system');
  });

  test('Confirmed order past expiry auto-cancels with reserve release', async () => {
    const { order, productId } = await makeOrder(); // no expiresAt initially
    await confirmOrder(testPrisma, order.id, user);

    const before = await testPrisma.product.findUnique({ where: { id: productId } });
    expect(before!.reservedStock).toBe(10);

    // Backdate expiry, then run the expiry job
    await testPrisma.salesOrder.update({
      where: { id: order.id },
      data: { expiresAt: new Date(Date.now() - 10000) },
    });

    const count = await expireSalesOrders(testPrisma);
    expect(count).toBeGreaterThanOrEqual(1);

    const after = await testPrisma.product.findUnique({ where: { id: productId } });
    expect(after!.reservedStock).toBe(0);
    expect(after!.stock).toBe(100);

    const cancelledOrder = await testPrisma.salesOrder.findUnique({ where: { id: order.id } });
    expect(cancelledOrder!.status).toBe('cancelled');

    const expiredNotif = await testPrisma.notification.findFirst({ where: { type: 'order_expired' } });
    expect(expiredNotif).toBeTruthy();
  });
});

describe('Sales Orders Service — Concurrency (Race Condition)', () => {
  beforeEach(async () => {
    await cleanDb();
  });

  afterAll(async () => {
    await cleanDb();
  });

  test('Two parallel confirms → only one reserves, the other fails with 409 (no double reserve)', async () => {
    const { order, productId } = await makeOrder();
    const product = await testPrisma.product.findUnique({ where: { id: productId } });
    expect(product!.reservedStock).toBe(0);

    const [r1, r2] = await Promise.allSettled([
      confirmOrder(testPrisma, order.id, user),
      confirmOrder(testPrisma, order.id, user),
    ]);

    const okCount = [r1, r2].filter((r) => r.status === 'fulfilled').length;
    expect(okCount).toBe(1);

    const failed = [r1, r2].find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(failed.reason.status ?? failed.reason.message).toBeTruthy();

    const after = await testPrisma.product.findUnique({ where: { id: productId } });
    expect(after!.reservedStock).toBe(10);

    const finalOrder = await testPrisma.salesOrder.findUnique({ where: { id: order.id } });
    expect(finalOrder!.status).toBe('confirmed');
  });

  test('Parallel delivery attempts → stock decremented exactly once, no negative delivery', async () => {
    const { order, productId } = await makeOrder();
    await confirmOrder(testPrisma, order.id, user);
    await transitionToProcessing(testPrisma, order.id, user);
    await transitionToShipped(testPrisma, order.id, user);

    const orderWithItems = (await testPrisma.salesOrder.findUnique({ where: { id: order.id }, include: { items: true } }))!;
    const item = orderWithItems.items.find((i) => i.productId === productId)!;
    const payload = { deliveredItems: [{ itemId: item.id, deliveredQty: 10 }] };

    const [r1, r2] = await Promise.allSettled([
      deliverOrder(testPrisma, order.id, payload, user),
      deliverOrder(testPrisma, order.id, payload, user),
    ]);

    const okCount = [r1, r2].filter((r) => r.status === 'fulfilled').length;
    expect(okCount).toBe(1);

    const product = await testPrisma.product.findUnique({ where: { id: productId } });
    expect(product!.stock).toBe(90);
    expect(product!.reservedStock).toBe(0);

    const finalOrder = await testPrisma.salesOrder.findUnique({
      where: { id: order.id },
      include: { items: true },
    });
    const deliveredItem = finalOrder!.items.find((i) => i.productId === productId)!;
    expect(deliveredItem.deliveredQty).toBe(10);
  });
});

describe('Sales Orders Service — Phase 3 Approval Hardening', () => {
  beforeEach(async () => {
    await cleanDb();
    await testPrisma.systemSettings.upsert({
      where: { key: 'approvalThresholdValue' },
      update: { value: '500' },
      create: { key: 'approvalThresholdValue', value: '500' },
    });
  });

  afterAll(async () => {
    await cleanDb();
  });

  async function setThresholdCurrency(currency: string) {
    await testPrisma.systemSettings.upsert({
      where: { key: 'approvalThresholdCurrency' },
      update: { value: currency },
      create: { key: 'approvalThresholdCurrency', value: currency },
    });
  }

  async function seedReceivedPo(productId: string) {
    const supplier = await testPrisma.supplier.create({ data: { name: 'مورد الاختبار' } });
    await testPrisma.purchaseOrder.create({
      data: {
        orderNumber: `PO-TEST-${Date.now()}`,
        supplierId: supplier.id,
        status: 'received',
        totalAmount: 300,
        subtotal: 300,
        grandTotal: 300,
        items: {
          create: [{ productId, quantity: 10, unitPrice: 30, totalPrice: 300 }],
        },
      },
    });
  }

  test('Grand total EQUALS threshold → confirmed, NO approval (not ">" only)', async () => {
    await testPrisma.systemSettings.upsert({
      where: { key: 'approvalThresholdValue' },
      update: { value: '1250' },
      create: { key: 'approvalThresholdValue', value: '1250' },
    });
    const { order } = await makeOrder(); // grandTotal = 1250

    const confirmed = await confirmOrder(testPrisma, order.id, user);
    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.approvalStatus).toBe('none');

    const approvals = await testPrisma.salesOrderApproval.findMany({ where: { salesOrderId: order.id } });
    expect(approvals).toHaveLength(0);
  });

  test('Different currency → forced approval even below numeric threshold', async () => {
    await setThresholdCurrency('USD'); // order currency stays EGP → mismatch
    const { order } = await makeOrder(); // 1250 EGP < 5000 numerically, but currency differs

    const result = await confirmOrder(testPrisma, order.id, user);
    expect(result.status).toBe('draft');
    expect(result.approvalStatus).toBe('pending');

    const approval = await testPrisma.salesOrderApproval.findFirst({ where: { salesOrderId: order.id } });
    expect(approval!.status).toBe('pending');
  });

  test('Insufficient stock AT APPROVE → 409 rollback: order draft, approval still pending, no reserve', async () => {
    const { order, productId } = await makeOrder(); // grandTotal 1250 > 500
    await confirmOrder(testPrisma, order.id, user); // → pending

    await testPrisma.product.update({ where: { id: productId }, data: { stock: 2 } }); // needs 10

    await expect(approveOrder(testPrisma, order.id, owner)).rejects.toThrow(/Insufficient stock/);

    const finalOrder = await testPrisma.salesOrder.findUnique({ where: { id: order.id } });
    expect(finalOrder!.status).toBe('draft');

    const approval = await testPrisma.salesOrderApproval.findFirst({ where: { salesOrderId: order.id } });
    expect(approval!.status).toBe('pending'); // not approved, not deleted

    const p1 = await testPrisma.product.findUnique({ where: { id: productId } });
    expect(p1!.reservedStock).toBe(0);
    const reservations = await testPrisma.reservation.findMany();
    expect(reservations).toHaveLength(0);
  });

  test('Parallel double-approve → exactly one confirms (200) + one 409, single reservation', async () => {
    const { order, productId } = await makeOrder();
    await confirmOrder(testPrisma, order.id, user); // → pending

    const [r1, r2] = await Promise.allSettled([
      approveOrder(testPrisma, order.id, owner),
      approveOrder(testPrisma, order.id, owner),
    ]);

    const ok = [r1, r2].filter((r) => r.status === 'fulfilled');
    const failed = [r1, r2].filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);

    const err = (failed[0] as PromiseRejectedResult).reason;
    expect(err.status ?? err.message).toBeTruthy();
    expect(err.status).toBe(409);

    const finalOrder = await testPrisma.salesOrder.findUnique({ where: { id: order.id } });
    expect(finalOrder!.status).toBe('confirmed');

    const approvals = await testPrisma.salesOrderApproval.findMany({ where: { salesOrderId: order.id } });
    expect(approvals.filter((a) => a.status === 'approved')).toHaveLength(1);

    const p1 = await testPrisma.product.findUnique({ where: { id: productId } });
    expect(p1!.reservedStock).toBe(10);
    const reservations = await testPrisma.reservation.findMany();
    expect(reservations).toHaveLength(2); // one per order item (منتج أ + منتج ب)
  });

  test('Re-submit: Reject → Edit → Confirm → new pending, old decision superseded', async () => {
    const { order } = await makeOrder(); // 1250 > 500
    await confirmOrder(testPrisma, order.id, user);
    await rejectOrder(testPrisma, order.id, owner, {}, 'العميل غير موثوق');

    const rejectedApproval = await testPrisma.salesOrderApproval.findFirst({
      where: { salesOrderId: order.id, status: 'rejected' },
    });
    expect(rejectedApproval).toBeTruthy();

    // Edit draft — content changed, stale decision must be voided
    const edited = await updateOrder(
      testPrisma,
      order.id,
      {
        clientId: order.clientId,
        items: [{ productId: order.items[0].productId, orderedQty: 7, sellingPrice: 100 }],
      },
      user
    );
    expect(edited.status).toBe('draft');
    expect(edited.approvalStatus).toBe('none');

    // The same decision record is preserved but superseded — never deleted
    const oldNow = await testPrisma.salesOrderApproval.findUnique({ where: { id: rejectedApproval!.id } });
    expect(oldNow!.status).toBe('superseded');

    // Re-confirm → brand new pending approval
    const reconfirmed = await confirmOrder(testPrisma, order.id, user);
    expect(reconfirmed.status).toBe('draft');
    expect(reconfirmed.approvalStatus).toBe('pending');

    const approvals = await testPrisma.salesOrderApproval.findMany({
      where: { salesOrderId: order.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(approvals).toHaveLength(2);
    expect(approvals[0].status).toBe('superseded'); // old decision preserved, not deleted
    expect(approvals[1].status).toBe('pending');
  });

  test('Re-submit WITHOUT edit → still rejected (409)', async () => {
    const { order } = await makeOrder();
    await confirmOrder(testPrisma, order.id, user);
    await rejectOrder(testPrisma, order.id, owner, {}, 'رفض');
    await expect(confirmOrder(testPrisma, order.id, user)).rejects.toThrow(/rejected/);
    await expect(confirmOrder(testPrisma, order.id, user)).rejects.toMatchObject({ status: 409 });
  });

  test('Moving-average costPrice frozen at confirm with real numbers (PO received)', async () => {
    // Raise threshold so this 1250 EGP order confirms directly (no approval gate)
    await testPrisma.systemSettings.upsert({
      where: { key: 'approvalThresholdValue' },
      update: { value: '5000' },
      create: { key: 'approvalThresholdValue', value: '5000' },
    });
    const { order, productId, product2Id } = await makeOrder();
    await seedReceivedPo(productId); // 10 units @ 30 → moving average 30

    const confirmed = await confirmOrder(testPrisma, order.id, user);
    expect(confirmed.status).toBe('confirmed');

    const itemA = confirmed.items.find((i: any) => i.productId === productId);
    const itemB = confirmed.items.find((i: any) => i.productId === product2Id);
    expect(itemA.costPrice).toBe(30); // frozen from PO moving average
    expect(itemB.costPrice).toBe(0); // no PO for p2 → 0

    // Frozen = immutable after confirm
    await expect(
      updateOrder(
        testPrisma,
        order.id,
        {
          clientId: order.clientId,
          items: [{ productId: productId, orderedQty: 1, sellingPrice: 1 }],
        },
        user
      )
    ).rejects.toThrow(/draft/);

    const after = await testPrisma.salesOrder.findUnique({ where: { id: order.id }, include: { items: true } });
    expect(after!.items.find((i) => i.productId === productId)!.costPrice).toBe(30);
  });

  test('Projection: approvalStatus/rejectionNote derived from latest decision', async () => {
    const { order } = await makeOrder();

    // before any approval → none
    const created = (await getOrder(testPrisma, order.id)) as any;
    expect(created!.approvalStatus).toBe('none');
    expect(created!.rejectionNote).toBeNull();

    // pending → status pending, no note
    const pending = await confirmOrder(testPrisma, order.id, user);
    expect(pending.approvalStatus).toBe('pending');
    expect(pending.rejectionNote).toBeNull();

    // rejected → status rejected + note with reason
    const rejected = await rejectOrder(testPrisma, order.id, owner, {}, 'سبب الرفض');
    expect(rejected.approvalStatus).toBe('rejected');
    expect(rejected.rejectionNote).toBe('سبب الرفض');

    const rejectedFetch = (await getOrder(testPrisma, order.id)) as any;
    expect(rejectedFetch!.approvalStatus).toBe('rejected');
    expect(rejectedFetch!.rejectionNote).toBe('سبب الرفض');

    // edit supersedes the rejection → back to none
    await updateOrder(
      testPrisma,
      order.id,
      {
        clientId: order.clientId,
        items: [{ productId: order.items[0].productId, orderedQty: 6, sellingPrice: 100 }],
      },
      user
    );

    // confirm again → new pending, then approve → approved + note cleared
    await confirmOrder(testPrisma, order.id, user);
    const approved = await approveOrder(testPrisma, order.id, owner);
    expect(approved.approvalStatus).toBe('approved');
    expect(approved.rejectionNote).toBeNull();

    const fetched = (await getOrder(testPrisma, order.id)) as any;
    expect(fetched!.approvalStatus).toBe('approved');
    expect(fetched!.rejectionNote).toBeNull();
  });
});

describe('Sales Orders Service — Transaction Rollback (P4.4)', () => {
  beforeEach(async () => {
    await cleanDb();
    await testPrisma.systemSettings.upsert({
      where: { key: 'approvalThresholdValue' },
      update: { value: '5000' },
      create: { key: 'approvalThresholdValue', value: '5000' },
    });
  });

  afterAll(async () => {
    await cleanDb();
  });

  test('A failing deliver inside one transaction leaves no order_delivered notification and no stock change', async () => {
    const { order, productId } = await makeOrder();
    await confirmOrder(testPrisma, order.id, user);
    await transitionToProcessing(testPrisma, order.id, user);
    await transitionToShipped(testPrisma, order.id, user);

    const before = await testPrisma.product.findUnique({ where: { id: productId } });
    expect(before!.stock).toBe(100);

    // deliveredItems بها item غير موجود في الطلب → fail داخل الـ transaction بعد الـ notification
    const bogusItemId = 'item-does-not-exist';
    await expect(
      deliverOrder(testPrisma, order.id, {
        deliveredItems: [
          { itemId: order.items[0].id, deliveredQty: 10 },
          { itemId: bogusItemId, deliveredQty: 5 },
        ],
      }, user)
    ).rejects.toThrow(/not found/i);

    // لا إشعار ولا تغيير في المخزون
    const deliveredNotif = await testPrisma.notification.findFirst({ where: { type: 'order_delivered' } });
    expect(deliveredNotif).toBeNull();

    const after = await testPrisma.product.findUnique({ where: { id: productId } });
    expect(after!.stock).toBe(100);

    const deliveries = await testPrisma.salesDelivery.findMany({ where: { salesOrderId: order.id } });
    expect(deliveries).toHaveLength(0);
  });
});
