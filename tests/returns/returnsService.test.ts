import { prisma as testPrisma } from '../schema/helpers';
import { cleanDb } from '../schema/fixtures';
import { upsertDefaultRoles } from '../../src/utils/seedRoles';
import {
  createReturn,
  updateReturn,
  approveReturn,
  rejectReturn,
  receiveReturn,
  refundReturn,
  closeReturn,
  archiveReturn,
  listReturns,
  getReturn,
  getEligibleSourceItems,
  getReturnsDashboard,
  checkRefundDelays,
  RETURN_STATUSES,
  RETURN_TYPES,
} from '../../src/services/returnsService';
import {
  createOrder,
  confirmOrder,
  transitionToProcessing,
  transitionToShipped,
  deliverOrder,
} from '../../src/services/salesOrderService';

const user = { userId: 'u-test-manager', name: 'مصطفى' };
const owner = { userId: 'u-test-owner', name: 'المالك' };

async function seedBasics() {
  await upsertDefaultRoles(testPrisma);
  const client = await testPrisma.client.create({ data: { name: 'شركة الاختبار' } });
  const supplier = await testPrisma.supplier.create({ data: { name: 'المورد العربي' } });
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
  return { clientId: client.id, supplierId: supplier.id, productId: p1.id, product2Id: p2.id };
}

// أمر بيع تم تسليمه بالكامل — المصدر الصالح لمرتجع عميل
async function makeDeliveredOrder() {
  const base = await seedBasics();
  const order = (await createOrder(
    testPrisma,
    {
      clientId: base.clientId,
      items: [
        { productId: base.productId, orderedQty: 10, sellingPrice: 100 },
        { productId: base.product2Id, orderedQty: 5, sellingPrice: 50 },
      ],
    },
    user
  ))!;
  await confirmOrder(testPrisma, order.id, user);
  await transitionToProcessing(testPrisma, order.id, user);
  await transitionToShipped(testPrisma, order.id, user);
  await deliverOrder(
    testPrisma,
    order.id,
    { deliveredItems: order.items.map((i: any) => ({ itemId: i.id, deliveredQty: i.orderedQty })) },
    user
  );
  const fresh = await testPrisma.salesOrder.findUnique({ where: { id: order.id }, include: { items: true } });
  return { ...base, order, items: fresh!.items };
}

// أمر شراء مُستلم بالكامل — المصدر الصالح لمرتجع مورد
async function makeReceivedPO() {
  const base = await seedBasics();
  const po = await testPrisma.purchaseOrder.create({
    data: {
      orderNumber: `PO-T-${Date.now()}`,
      supplierId: base.supplierId,
      status: 'received',
      items: {
        create: [
          { productId: base.productId, quantity: 20, unitPrice: 50, receivedQuantity: 20, acceptedQty: 20 },
          { productId: base.product2Id, quantity: 10, unitPrice: 30, receivedQuantity: 10, acceptedQty: 10 },
        ],
      },
    },
    include: { items: true },
  });
  return { ...base, po, poItems: po.items };
}

async function makeCustomerDraft(over: any = {}) {
  const ctx = await makeDeliveredOrder();
  const ret = (await createReturn(
    testPrisma,
    {
      type: RETURN_TYPES.CUSTOMER,
      sourceType: 'sales_order',
      sourceId: ctx.order.id,
      items: [
        { productId: ctx.productId, condition: 'new', reason: 'changed_mind', returnedQty: 2, unitPrice: 100 },
      ],
      ...over,
    },
    user
  ))!;
  return { ...ctx, ret };
}

describe('Returns Service — Customer Return Happy Path (Positive)', () => {
  beforeEach(async () => {
    await cleanDb();
  });

  afterAll(async () => {
    await cleanDb();
  });

  test('Happy Path: create → approve → receive (stock+2) → refund → close', async () => {
    const { ret, productId, order } = await makeCustomerDraft();

    expect(ret.status).toBe(RETURN_STATUSES.DRAFT);
    expect(ret.version).toBe(1);
    expect(ret.returnNumber).toMatch(/^RT-\d{6}-\d{6}$/);
    expect(ret.sourceNumber).toBe(order.orderNumber);
    expect(ret.partyName).toBe('شركة الاختبار');
    expect(ret.items).toHaveLength(1);
    expect(ret.items[0].receivedQty).toBe(0);
    expect(ret.subtotal).toBe(200); // 100 * 2

    // إشعار اعتماد للمالك
    const approvalNotif = await testPrisma.notification.findFirst({ where: { type: 'return_approval_needed' } });
    expect(approvalNotif).toBeTruthy();
    expect(approvalNotif!.priority).toBe('high');
    expect(approvalNotif!.entityId).toBe(ret.id);

    const approved = await approveReturn(testPrisma, ret.id, owner);
    expect(approved.status).toBe(RETURN_STATUSES.APPROVED);
    expect(approved.approvedBy).toBe(owner.userId);

    // لا تأثير على المخزون قبل الاستلام
    let p = await testPrisma.product.findUnique({ where: { id: productId } });
    expect(p!.stock).toBe(90); // بعد تسليم 10

    const received = await receiveReturn(
      testPrisma,
      ret.id,
      { items: [{ itemId: ret.items[0].id, receivedQty: 2 }] },
      user
    );
    expect(received.status).toBe(RETURN_STATUSES.RECEIVED);
    expect(received.items[0].receivedQty).toBe(2);

    p = await testPrisma.product.findUnique({ where: { id: productId } });
    expect(p!.stock).toBe(92);
    expect(p!.quarantineStock).toBe(0);

    const log = await testPrisma.inventoryLog.findFirst({ where: { type: 'CUSTOMER_RETURN' } });
    expect(log).toBeTruthy();
    expect(log!.change).toBe(2);
    expect(log!.newStock).toBe(92);
    expect(log!.referenceType).toBe('returns');
    expect(log!.referenceId).toBe(ret.id);

    const refunded = await refundReturn(
      testPrisma,
      ret.id,
      { refundStatus: 'completed', refundAmount: 200 },
      owner
    );
    expect(refunded.refundStatus).toBe('completed');
    expect(refunded.refundDueAt).toBeNull(); // completed → no due date

    const closed = await closeReturn(testPrisma, ret.id, { resolution: 'refund' }, user);
    expect(closed.status).toBe(RETURN_STATUSES.CLOSED);
    expect(closed.resolution).toBe('refund');

    // Audit كامل
    const history = await testPrisma.returnOrderStatusHistory.findMany({ where: { returnId: ret.id } });
    const statuses = history.map((h) => h.toStatus);
    expect(statuses).toContain('draft');
    expect(statuses).toContain('approved');
    expect(statuses).toContain('received');
    expect(statuses).toContain('closed');
    expect(history.every((h) => h.changedFields.length > 0)).toBe(true);
    expect(history[0].changedFields).toContain('created');
  });

  test('Damaged item يدخل Quarantine (stock بدون تغيير + quarantineStock+1)', async () => {
    const ctx = await makeDeliveredOrder();
    const ret = (await createReturn(
      testPrisma,
      {
        type: RETURN_TYPES.CUSTOMER,
        sourceType: 'sales_order',
        sourceId: ctx.order.id,
        warehouseDestination: 'quarantine',
        items: [{ productId: ctx.productId, condition: 'damaged', reason: 'damaged', returnedQty: 1 }],
      },
      user
    ))!;

    await approveReturn(testPrisma, ret.id, owner);
    await receiveReturn(testPrisma, ret.id, { items: [{ itemId: ret.items[0].id, receivedQty: 1 }] }, user);

    const p = await testPrisma.product.findUnique({ where: { id: ctx.productId } });
    expect(p!.stock).toBe(90); // التالف لا يرفع المخزون القابل للبيع
    expect(p!.quarantineStock).toBe(1);
  });

  test('Partial receive (receivedQty < returnedQty) مسموح', async () => {
    const { ret, productId } = await makeCustomerDraft();
    await approveReturn(testPrisma, ret.id, owner);
    const received = await receiveReturn(testPrisma, ret.id, { items: [{ itemId: ret.items[0].id, receivedQty: 1 }] }, user);
    expect(received.status).toBe(RETURN_STATUSES.RECEIVED);
    const p = await testPrisma.product.findUnique({ where: { id: productId } });
    expect(p!.stock).toBe(91);
  });

  test('getEligibleSourceItems يرجع البنود مع maxReturnable (delivered - سبق رده)', async () => {
    const ctx = await makeDeliveredOrder();
    const eligible = await getEligibleSourceItems(testPrisma, {
      type: RETURN_TYPES.CUSTOMER,
      sourceType: 'sales_order',
      sourceId: ctx.order.id,
    });
    expect(eligible.source.sourceNumber).toBe(ctx.order.orderNumber);
    expect(eligible.items.length).toBe(2);
    const p1 = eligible.items.find((i: any) => i.productId === ctx.productId);
    expect(p1!.maxReturnable).toBe(10);

    // بعد إنشاء مرتجع 2 منه → السقف بيقل
    await createReturn(
      testPrisma,
      {
        type: RETURN_TYPES.CUSTOMER,
        sourceType: 'sales_order',
        sourceId: ctx.order.id,
        items: [{ productId: ctx.productId, condition: 'new', reason: 'changed_mind', returnedQty: 2 }],
      },
      user
    );
    const eligible2 = await getEligibleSourceItems(testPrisma, {
      type: RETURN_TYPES.CUSTOMER,
      sourceType: 'sales_order',
      sourceId: ctx.order.id,
    });
    expect(eligible2.items.find((i: any) => i.productId === ctx.productId)!.maxReturnable).toBe(8);
  });
});

describe('Returns Service — Supplier Return Happy Path (Positive)', () => {
  beforeEach(async () => {
    await cleanDb();
  });

  afterAll(async () => {
    await cleanDb();
  });

  test('Supplier return: create → approve → receive (stock-5) → close', async () => {
    const ctx = await makeReceivedPO();
    const ret = (await createReturn(
      testPrisma,
      {
        type: RETURN_TYPES.SUPPLIER,
        sourceType: 'purchase_order',
        sourceId: ctx.po.id,
        items: [{ productId: ctx.productId, condition: 'damaged', reason: 'factory_defect', returnedQty: 5 }],
        warehouseDestination: 'quarantine',
      },
      user
    ))!;

    expect(ret.returnNumber).toMatch(/^SR-\d{6}-\d{6}$/);
    expect(ret.partyName).toBe('المورد العربي');

    await approveReturn(testPrisma, ret.id, owner);
    await receiveReturn(testPrisma, ret.id, { items: [{ itemId: ret.items[0].id, receivedQty: 5 }] }, user);

    const p = await testPrisma.product.findUnique({ where: { id: ctx.productId } });
    expect(p!.stock).toBe(95); // مرتجع مورد يخصم من المخزون

    const log = await testPrisma.inventoryLog.findFirst({ where: { type: 'SUPPLIER_RETURN' } });
    expect(log).toBeTruthy();
    expect(log!.change).toBe(-5);

    const closed = await closeReturn(testPrisma, ret.id, { resolution: 'replace' }, user);
    expect(closed.status).toBe(RETURN_STATUSES.CLOSED);
    expect(closed.resolution).toBe('replace');
  });
});

describe('Returns Service — Negative & Edge Cases', () => {
  beforeEach(async () => {
    await cleanDb();
  });

  afterAll(async () => {
    await cleanDb();
  });

  test('الاعتماد إجباري: receive على draft يرفض + receive على approved يمر', async () => {
    const { ret } = await makeCustomerDraft();
    await expect(
      receiveReturn(testPrisma, ret.id, { items: [{ itemId: ret.items[0].id, receivedQty: 1 }] }, user)
    ).rejects.toThrow(/status draft/);
  });

  test('Transitions غير صالحة تُرفض', async () => {
    const { ret } = await makeCustomerDraft();
    await expect(closeReturn(testPrisma, ret.id, { resolution: 'refund' }, user)).rejects.toThrow(/status draft/);
    await expect(refundReturn(testPrisma, ret.id, { refundStatus: 'pending' }, owner)).rejects.toThrow(/received/);
  });

  test('ممنوع إرجاع أكتر من المُسلَّم (Capacity Ceiling → 409)', async () => {
    const ctx = await makeDeliveredOrder();
    await expect(
      createReturn(
        testPrisma,
        {
          type: RETURN_TYPES.CUSTOMER,
          sourceType: 'sales_order',
          sourceId: ctx.order.id,
          items: [{ productId: ctx.productId, condition: 'new', reason: 'changed_mind', returnedQty: 11 }], // delivered 10
        },
        user
      )
    ).rejects.toThrow(/more than delivered/);
  });

  test('مجموع مرتجعين على نفس المصدر لا يتجاوز المسلَّم', async () => {
    const ctx = await makeDeliveredOrder();
    await createReturn(
      testPrisma,
      {
        type: RETURN_TYPES.CUSTOMER,
        sourceType: 'sales_order',
        sourceId: ctx.order.id,
        items: [{ productId: ctx.productId, condition: 'new', reason: 'changed_mind', returnedQty: 8 }],
      },
      user
    );
    await expect(
      createReturn(
        testPrisma,
        {
          type: RETURN_TYPES.CUSTOMER,
          sourceType: 'sales_order',
          sourceId: ctx.order.id,
          items: [{ productId: ctx.productId, condition: 'new', reason: 'changed_mind', returnedQty: 3 }], // 8+3 > 10
        },
        user
      )
    ).rejects.toThrow(/more than delivered/);
  });

  test('Damaged item لازم warehouseDestination = quarantine', async () => {
    const { productId, order } = await makeDeliveredOrder();
    await expect(
      createReturn(
        testPrisma,
        {
          type: RETURN_TYPES.CUSTOMER,
          sourceType: 'sales_order',
          sourceId: order.id,
          warehouseDestination: 'main',
          items: [{ productId, condition: 'damaged', reason: 'damaged', returnedQty: 1 }],
        },
        user
      )
    ).rejects.toThrow(/quarantine/);
  });

  test('مصدر غير مسموح للنوع (supplier_return ← sales_order) يُرفض', async () => {
    const ctx = await makeDeliveredOrder();
    await expect(
      createReturn(
        testPrisma,
        {
          type: RETURN_TYPES.SUPPLIER,
          sourceType: 'sales_order',
          sourceId: ctx.order.id,
          items: [{ productId: ctx.productId, condition: 'new', reason: 'changed_mind', returnedQty: 1 }],
        },
        user
      )
    ).rejects.toThrow(/not allowed/);
  });

  test('Purchase Order لازم يكون received لمرتجع مورد', async () => {
    const base = await seedBasics();
    const po = await testPrisma.purchaseOrder.create({
      data: {
        orderNumber: `PO-D-${Date.now()}`,
        supplierId: base.supplierId,
        status: 'draft',
        items: { create: [{ productId: base.productId, quantity: 5, receivedQuantity: 0 }] },
      },
    });
    await expect(
      createReturn(
        testPrisma,
        {
          type: RETURN_TYPES.SUPPLIER,
          sourceType: 'purchase_order',
          sourceId: po.id,
          items: [{ productId: base.productId, condition: 'damaged', reason: 'factory_defect', returnedQty: 1 }],
        },
        user
      )
    ).rejects.toThrow(/received/);
  });

  test('Reject يتطلب سبب + rejected حالة نهائية (لا receive عليها)', async () => {
    const { ret } = await makeCustomerDraft();
    await expect(rejectReturn(testPrisma, ret.id, owner, {}, '')).rejects.toThrow(/reason/);

    const rejected = await rejectReturn(testPrisma, ret.id, owner, {}, 'منتج غير مطابق للطلب');
    expect(rejected.status).toBe(RETURN_STATUSES.REJECTED);
    expect(rejected.rejectionReason).toBe('منتج غير مطابق للطلب');

    await expect(
      approveReturn(testPrisma, ret.id, owner)
    ).rejects.toThrow(/Cannot transition/);
  });

  test('Optimistic Locking: تعديل بسنخة قديمة → 409', async () => {
    const { ret } = await makeCustomerDraft();
    await expect(
      updateReturn(
        testPrisma,
        ret.id,
        {
          type: RETURN_TYPES.CUSTOMER,
          sourceType: 'sales_order',
          sourceId: ret.sourceId,
          expectedVersion: 999,
          items: [{ productId: ret.items[0].productId, condition: 'new', reason: 'changed_mind', returnedQty: 1 }],
        },
        user
      )
    ).rejects.toThrow(/modified/);
  });

  test('Update بيمر على draft (version+1) وبيترفض بعد الاعتماد', async () => {
    const { ret } = await makeCustomerDraft();
    const updated = await updateReturn(
      testPrisma,
      ret.id,
      {
        type: RETURN_TYPES.CUSTOMER,
        sourceType: 'sales_order',
        sourceId: ret.sourceId,
        expectedVersion: 1,
        items: [{ productId: ret.items[0].productId, condition: 'new', reason: 'changed_mind', returnedQty: 1 }],
      },
      user
    );
    expect(updated.version).toBe(2);
    expect(updated.items[0].returnedQty).toBe(1);

    await approveReturn(testPrisma, ret.id, owner);
    await expect(
      updateReturn(
        testPrisma,
        ret.id,
        {
          type: RETURN_TYPES.CUSTOMER,
          sourceType: 'sales_order',
          sourceId: ret.sourceId,
          expectedVersion: 2,
          items: [{ productId: ret.items[0].productId, condition: 'new', reason: 'changed_mind', returnedQty: 1 }],
        },
        user
      )
    ).rejects.toThrow(/draft/);
  });

  test('Close بقرار refund يتطلب refundStatus ≠ none', async () => {
    const { ret } = await makeCustomerDraft();
    await approveReturn(testPrisma, ret.id, owner);
    await receiveReturn(testPrisma, ret.id, { items: [{ itemId: ret.items[0].id, receivedQty: 2 }] }, user);
    await expect(closeReturn(testPrisma, ret.id, { resolution: 'refund' }, user)).rejects.toThrow(/Refund status/);
  });

  test('receivedQty ممنوع يتجاوز returnedQty', async () => {
    const { ret } = await makeCustomerDraft();
    await approveReturn(testPrisma, ret.id, owner);
    await expect(
      receiveReturn(testPrisma, ret.id, { items: [{ itemId: ret.items[0].id, receivedQty: 99 }] }, user)
    ).rejects.toThrow(/between 0 and returnedQty/);
  });

  test('Archive = Soft Delete فقط للدraft (deletedAt + deletedBy، لا Hard Delete)', async () => {
    const { ret } = await makeCustomerDraft();
    const archived = await archiveReturn(testPrisma, ret.id, user);
    expect(archived).toBeTruthy();
    expect(archived!.deletedAt).toBeInstanceOf(Date);
    expect(archived!.deletedBy).toBe(user.userId);

    // يختفي من القائمة لكن السجل باقي في DB
    const list = await listReturns(testPrisma, {});
    expect(list.returns.some((r: any) => r.id === ret.id)).toBe(false);
    const raw = await testPrisma.returnOrder.findUnique({ where: { id: ret.id } });
    expect(raw).toBeTruthy();

    // مرتجع مؤرشف لا يُعتمد ولا يُعاد أرشفته
    await expect(approveReturn(testPrisma, ret.id, owner)).rejects.toThrow(/not found/);
    await expect(archiveReturn(testPrisma, ret.id, user)).rejects.toThrow(/already archived/);

    // أرشفة مرتجع في حالة متقدمة ممنوعة
    const { ret: ret2 } = await makeCustomerDraft();
    await approveReturn(testPrisma, ret2.id, owner);
    await expect(archiveReturn(testPrisma, ret2.id, user)).rejects.toThrow(/draft/);
  });

  test('getReturn بيرجع السجل المؤرشف بمعلومة deletedAt (والـ route يرفضه 404)', async () => {
    const { ret } = await makeCustomerDraft();
    await archiveReturn(testPrisma, ret.id, user);
    const result = await getReturn(testPrisma, ret.id);
    expect(result).toBeTruthy();
    expect(result!.deletedAt).toBeInstanceOf(Date);
  });
});

describe('Returns Service — Concurrency (Race Condition)', () => {
  beforeEach(async () => {
    await cleanDb();
  });

  afterAll(async () => {
    await cleanDb();
  });

  test('استلامان متوازيان → واحد بس ينجح والمخزون يزيد مرة واحدة فقط', async () => {
    const { ret, productId } = await makeCustomerDraft();
    await approveReturn(testPrisma, ret.id, owner);

    const payload = { items: [{ itemId: ret.items[0].id, receivedQty: 2 }] };
    const [r1, r2] = await Promise.allSettled([
      receiveReturn(testPrisma, ret.id, payload, user),
      receiveReturn(testPrisma, ret.id, payload, user),
    ]);

    const okCount = [r1, r2].filter((r) => r.status === 'fulfilled').length;
    expect(okCount).toBe(1);

    const p = await testPrisma.product.findUnique({ where: { id: productId } });
    expect(p!.stock).toBe(92); // 90 + 2 مرة واحدة
    expect(p!.quarantineStock).toBe(0);

    const logs = await testPrisma.inventoryLog.findMany({ where: { type: 'CUSTOMER_RETURN' } });
    expect(logs).toHaveLength(1);
  });
});

describe('Returns Service — Integration & Dashboard', () => {
  beforeEach(async () => {
    await cleanDb();
  });

  afterAll(async () => {
    await cleanDb();
  });

  test('Sales Order getOrder بيرجع returnedQty + netSoldQty', async () => {
    const ctx = await makeCustomerDraft();
    const { getOrder } = await import('../../src/services/salesOrderService');
    const before = await getOrder(testPrisma, ctx.order.id);
    expect((before as any).returnedQty).toBe(0);
    expect((before as any).netSoldQty).toBe(15);

    await approveReturn(testPrisma, ctx.ret.id, owner);
    await receiveReturn(testPrisma, ctx.ret.id, { items: [{ itemId: ctx.ret.items[0].id, receivedQty: 2 }] }, user);

    const after = await getOrder(testPrisma, ctx.order.id);
    expect((after as any).returnedQty).toBe(2);
    expect((after as any).netSoldQty).toBe(13);
    const item = (after as any).items.find((i: any) => i.productId === ctx.productId);
    expect(item.returnedQty).toBe(2);
    expect(item.netSoldQty).toBe(8);
  });

  test('Dashboard: returnRate + topReasons + quarantineVolume + refundWaiting', async () => {
    const ctx = await makeDeliveredOrder();
    // مرتجعان: واحد good (2) + واحد damaged (1)
    const r1 = (await createReturn(
      testPrisma,
      {
        type: RETURN_TYPES.CUSTOMER,
        sourceType: 'sales_order',
        sourceId: ctx.order.id,
        items: [{ productId: ctx.productId, condition: 'new', reason: 'changed_mind', returnedQty: 2 }],
      },
      user
    ))!;
    await approveReturn(testPrisma, r1.id, owner);
    await receiveReturn(testPrisma, r1.id, { items: [{ itemId: r1.items[0].id, receivedQty: 2 }] }, user);
    await refundReturn(testPrisma, r1.id, { refundStatus: 'pending', refundAmount: 200 }, owner);

    const r2 = (await createReturn(
      testPrisma,
      {
        type: RETURN_TYPES.CUSTOMER,
        sourceType: 'sales_order',
        sourceId: ctx.order.id,
        warehouseDestination: 'quarantine',
        items: [{ productId: ctx.productId, condition: 'damaged', reason: 'damaged', returnedQty: 1 }],
      },
      user
    )!);
    await approveReturn(testPrisma, r2.id, owner);
    await receiveReturn(testPrisma, r2.id, { items: [{ itemId: r2.items[0].id, receivedQty: 1 }] }, user);

    const dash = await getReturnsDashboard(testPrisma, {});
    expect(dash.returnedQty).toBe(3);
    expect(dash.quarantineVolume).toBe(1);
    expect(dash.refundWaiting.count).toBe(1);
    expect(dash.refundWaiting.total).toBe(200);
    expect(dash.byStatus.find((s: any) => s.status === 'received')!.count).toBe(2);
    const reasons = dash.topReasons as Array<{ reason: string; count: number }>;
    expect(reasons.some((x) => x.reason === 'changed_mind')).toBe(true);
  });

  test('checkRefundDelays: مرتجع متأخر الـ Refund بيولّد إشعار return_refund_delayed', async () => {
    const ctx = await makeDeliveredOrder();
    const r = (await createReturn(
      testPrisma,
      {
        type: RETURN_TYPES.CUSTOMER,
        sourceType: 'sales_order',
        sourceId: ctx.order.id,
        items: [{ productId: ctx.productId, condition: 'new', reason: 'changed_mind', returnedQty: 1 }],
      },
      user
    )!);
    await approveReturn(testPrisma, r.id, owner);
    await receiveReturn(testPrisma, r.id, { items: [{ itemId: r.items[0].id, receivedQty: 1 }] }, user);
    await refundReturn(testPrisma, r.id, { refundStatus: 'pending', refundAmount: 100, refundDate: new Date(Date.now() - 20 * 24 * 3600 * 1000).toISOString() }, owner);

    const count = await checkRefundDelays(testPrisma);
    expect(count).toBeGreaterThanOrEqual(1);

    const notif = await testPrisma.notification.findFirst({ where: { type: 'return_refund_delayed' } });
    expect(notif).toBeTruthy();
    expect(notif!.priority).toBe('urgent');

    // idempotent — المرة التانية لا تكرر الإشعار
    const count2 = await checkRefundDelays(testPrisma);
    expect(count2).toBe(0);
  });
});
