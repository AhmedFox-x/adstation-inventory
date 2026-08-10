import { prisma as testPrisma } from '../schema/helpers';
import { cleanDb } from '../schema/fixtures';
import { createNotification, createNotifications } from '../../src/services/notificationService';

describe('Notification Service', () => {
  let userId: string;

  beforeEach(async () => {
    await cleanDb();
    const user = await testPrisma.user.create({
      data: {
        email: `notif-${Date.now()}@x.com`,
        password: 'hash',
        firstName: 'N',
        lastName: 'T',
        role: 'manager',
      },
    });
    userId = user.id;
  });

  afterAll(async () => {
    await cleanDb();
  });

  it('createNotification creates a system notification with createdBySystem=true and unified metadata', async () => {
    const created = await createNotification(testPrisma, {
      userId,
      type: 'order_confirmed',
      title: 'تم تأكيد الطلب',
      message: 'تم تأكيد الطلب SO-1',
      entityType: 'sales_order',
      entityId: 'ord-1',
      priority: 'normal',
    });

    expect(created).not.toBeNull();
    expect(created!.userId).toBe(userId);
    expect(created!.type).toBe('order_confirmed');
    expect(created!.title).toBe('تم تأكيد الطلب');
    expect(created!.entityType).toBe('sales_order');
    expect(created!.entityId).toBe('ord-1');
    expect(created!.priority).toBe('normal');
    expect(created!.icon).toBe('approval');
    expect(created!.actionUrl).toBe('/sales-orders?focus=ord-1');
    expect(created!.createdBySystem).toBe(true);
    expect(created!.isRead).toBe(false);
    expect(created!.deletedAt).toBeNull();
  });

  it('createNotification defaults priority to normal and applies defaults', async () => {
    const created = await createNotification(testPrisma, {
      userId,
      type: 'return_created',
      title: 'تم إنشاء المرتجع',
      message: 'RET-1',
    });

    expect(created).not.toBeNull();
    expect(created!.priority).toBe('normal');
    expect(created!.createdBySystem).toBe(true);
  });

  it('createNotification skips null/undefined userId without failing', async () => {
    const forNull = await createNotification(testPrisma, {
      userId: null,
      type: 'order_expired',
      title: 'انتهت صلاحية الطلب',
      message: 'x',
    });
    const forUndefined = await createNotification(testPrisma, {
      userId: undefined,
      type: 'order_expired',
      title: 'انتهت صلاحية الطلب',
      message: 'x',
    });

    expect(forNull).toBeNull();
    expect(forUndefined).toBeNull();

    const count = await testPrisma.notification.count();
    expect(count).toBe(0);
  });

  it('createNotifications creates one notification per unique recipient', async () => {
    await createNotifications(
      testPrisma,
      [userId, userId, 'other-user'],
      {
        type: 'approval_needed',
        title: 'طلب يحتاج اعتماد',
        message: 'SO-1',
        entityType: 'sales_order',
        entityId: 'ord-1',
      }
    );

    const all = await testPrisma.notification.findMany({ orderBy: { userId: 'asc' } });
    expect(all).toHaveLength(2);
    expect(all.map((n) => n.userId).sort()).toEqual([userId, 'other-user'].sort());
    expect(all.every((n) => n.createdBySystem === true)).toBe(true);
  });

  it('createNotifications skips null/undefined/empty recipients without failing', async () => {
    await createNotifications(
      testPrisma,
      [userId, null, undefined, '', '   '],
      {
        type: 'low_stock',
        title: 'مخزون منخفض',
        message: 'منتج',
      }
    );

    const all = await testPrisma.notification.findMany();
    expect(all).toHaveLength(1);
    expect(all[0].userId).toBe(userId);
  });

  it('createNotification works inside a $transaction (tx client)', async () => {
    await testPrisma.$transaction(async (tx) => {
      await createNotification(tx as any, {
        userId,
        type: 'order_confirmed',
        title: 'تم تأكيد الطلب',
        message: 'SO-tx',
      });
      await createNotifications(
        tx as any,
        [userId, 'owner-1'],
        {
          type: 'approval_needed',
          title: 'طلب يحتاج اعتماد',
          message: 'SO-tx',
        }
      );
    });

    const all = await testPrisma.notification.findMany();
    expect(all).toHaveLength(3);
  });

  it('rolls back a single notification if the transaction fails AFTER create', async () => {
    await expect(
      testPrisma.$transaction(async (tx) => {
        await createNotification(tx as any, {
          userId,
          type: 'order_approved',
          title: 'تم اعتماد الطلب',
          message: 'SO-rollback',
        });
        throw new Error('boom-after-notification');
      })
    ).rejects.toThrow('boom-after-notification');

    const count = await testPrisma.notification.count();
    expect(count).toBe(0);
  });

  it('rolls back batch notifications if the transaction fails AFTER createNotifications', async () => {
    await expect(
      testPrisma.$transaction(async (tx) => {
        await createNotifications(
          tx as any,
          [userId, userId, 'owner-1', ''],
          {
            type: 'approval_needed',
            title: 'طلب يحتاج اعتماد',
            message: 'SO-batch-rollback',
          }
        );
        throw new Error('boom-after-batch');
      })
    ).rejects.toThrow('boom-after-batch');

    const count = await testPrisma.notification.count();
    expect(count).toBe(0);
  });

  it('does not orphan notifications when a later tx step fails (multi-table scenario)', async () => {
    // يحاكي عملية حقيقية: إشعار + كيان آخر داخل نفس الـ transaction، والفشل بعد الإشعار
    const other = await testPrisma.client.create({ data: { name: 'عميل الـ tx' } });
    await testPrisma.$transaction(async (tx) => {
      await createNotification(tx as any, {
        userId,
        type: 'return_received',
        title: 'تم استلام المرتجع',
        message: 'RET-tx',
        entityType: 'return_order',
        entityId: 'ret-x',
      });
      await tx.salesOrder.create({
        data: {
          orderNumber: 'SO-rollback-2',
          status: 'draft',
          clientId: other.id,
          createdBy: userId,
          expiresAt: new Date(),
        },
      });
      throw new Error('boom-after-multi-table');
    }).catch(() => {});

    const notifCount = await testPrisma.notification.count();
    expect(notifCount).toBe(0);
    const orderCount = await testPrisma.salesOrder.count({ where: { orderNumber: 'SO-rollback-2' } });
    expect(orderCount).toBe(0);
  });

  it('keeps notifications when the transaction commits successfully (positive control)', async () => {
    await testPrisma.$transaction(async (tx) => {
      await createNotification(tx as any, {
        userId,
        type: 'order_delivered',
        title: 'تم التوصيل',
        message: 'SO-commit',
      });
    });

    const all = await testPrisma.notification.findMany();
    expect(all).toHaveLength(1);
    expect(all[0].type).toBe('order_delivered');
  });

  it('maps every business event to its unified semantic icon', async () => {
    const cases: Array<[string, string]> = [
      ['approval_needed', 'approval'],
      ['order_approved', 'approval'],
      ['order_rejected', 'approval'],
      ['order_confirmed', 'approval'],
      ['return_approval_needed', 'approval'],
      ['return_approved', 'approval'],
      ['return_rejected', 'approval'],
      ['order_delivered', 'delivery'],
      ['low_stock', 'inventory'],
      ['return_created', 'return'],
      ['return_received', 'return'],
      ['return_refund_pending', 'return'],
      ['return_refund_completed', 'return'],
      ['return_refund_delayed', 'return'],
      ['return_closed', 'return'],
      ['return_archived', 'return'],
      ['order_expired', 'warning'],
    ];

    for (const [type, expectedIcon] of cases) {
      const created = await createNotification(testPrisma, {
        userId,
        type,
        title: type,
        message: type,
      });
      expect(created).not.toBeNull();
      expect(created!.icon).toBe(expectedIcon);
      expect(created!.actionUrl).toBeNull();
    }
  });

  it('builds actionUrl from the actual linked entity and keeps explicit overrides', async () => {
    const byEntity = await createNotification(testPrisma, {
      userId,
      type: 'order_delivered',
      title: 'تم التوصيل',
      message: 'SO-2',
      entityType: 'sales_order',
      entityId: 'ord-2',
    });
    expect(byEntity!.icon).toBe('delivery');
    expect(byEntity!.actionUrl).toBe('/sales-orders?focus=ord-2');

    const lowStock = await createNotification(testPrisma, {
      userId,
      type: 'low_stock',
      title: 'مخزون منخفض',
      message: 'منتج',
      entityType: 'product',
      entityId: 'prod-9',
    });
    expect(lowStock!.icon).toBe('inventory');
    expect(lowStock!.entityType).toBe('product');
    expect(lowStock!.entityId).toBe('prod-9');
    expect(lowStock!.actionUrl).toBe('/products?focus=prod-9');

    const overridden = await createNotification(testPrisma, {
      userId,
      type: 'order_confirmed',
      title: 'تم تأكيد الطلب',
      message: 'SO-3',
      entityType: 'sales_order',
      entityId: 'ord-3',
      icon: 'custom-icon',
      actionUrl: '/custom/route',
    });
    expect(overridden!.icon).toBe('custom-icon');
    expect(overridden!.actionUrl).toBe('/custom/route');
  });
});
