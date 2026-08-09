import { Request, Response } from 'express';
import { prisma as testPrisma } from '../schema/helpers';
import { cleanDb } from '../schema/fixtures';
import { upsertDefaultRoles } from '../../src/utils/seedRoles';
import { requirePermission } from '../../src/middleware/auth';
import { PERMISSIONS } from '../../src/utils/permissions';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

describe('requirePermission Middleware — Sales Orders (Positive & Negative)', () => {
  let ownerId: string;
  let managerId: string;
  let viewerId: string;

  beforeEach(async () => {
    await cleanDb();
    await upsertDefaultRoles(testPrisma);

    const ownerRole = await testPrisma.roleConfig.findUnique({ where: { name: 'owner' } });
    const managerRole = await testPrisma.roleConfig.findUnique({ where: { name: 'manager' } });
    const viewerRole = await testPrisma.roleConfig.findUnique({ where: { name: 'viewer' } });

    const owner = await testPrisma.user.create({
      data: {
        email: `owner-${Date.now()}@x.com`,
        password: 'hash',
        firstName: 'O',
        lastName: 'W',
        role: 'owner',
        roleId: ownerRole!.id,
      },
    });
    const manager = await testPrisma.user.create({
      data: {
        email: `mgr-${Date.now()}@x.com`,
        password: 'hash',
        firstName: 'M',
        lastName: 'G',
        role: 'manager',
        roleId: managerRole!.id,
      },
    });
    const viewer = await testPrisma.user.create({
      data: {
        email: `view-${Date.now()}@x.com`,
        password: 'hash',
        firstName: 'V',
        lastName: 'I',
        role: 'viewer',
        roleId: viewerRole!.id,
      },
    });

    ownerId = owner.id;
    managerId = manager.id;
    viewerId = viewer.id;
  });

  afterAll(async () => {
    await cleanDb();
  });

  function makeReq(userId: string, role: string): Request {
    const token = jwt.sign({ userId, email: 'x@x.com', role }, JWT_SECRET);
    return { headers: {}, user: { userId, email: 'x@x.com', role }, token } as unknown as Request;
  }

  function makeRes() {
    let statusCode = 200;
    let body: any = null;
    return {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json(b: any) {
        body = b;
        return this;
      },
      getStatus: () => statusCode,
      getBody: () => body,
    } as unknown as Response & { getStatus(): number; getBody(): any };
  }

  function runGuard(userId: string, role: string, perm: string): Promise<number> {
    return new Promise((resolve) => {
      const res = makeRes();
      const next = () => resolve(res.getStatus());
      requirePermission(perm)(makeReq(userId, role), res, next as any)
        .then(() => {
          resolve(res.getStatus());
        })
        .catch(() => resolve(res.getStatus()));
    });
  }

  test('POSITIVE: الـ Owner يمر بكل صلاحيات sales_orders.* (200)', async () => {
    const perms = [
      PERMISSIONS.SALES_ORDERS_VIEW,
      PERMISSIONS.SALES_ORDERS_CREATE,
      PERMISSIONS.SALES_ORDERS_EDIT_DRAFT,
      PERMISSIONS.SALES_ORDERS_CONFIRM,
      PERMISSIONS.SALES_ORDERS_PROCESS,
      PERMISSIONS.SALES_ORDERS_SHIP,
      PERMISSIONS.SALES_ORDERS_DELIVER,
      PERMISSIONS.SALES_ORDERS_APPROVE,
      PERMISSIONS.SALES_ORDERS_REJECT,
      PERMISSIONS.SALES_ORDERS_CLOSE,
      PERMISSIONS.SALES_ORDERS_CANCEL,
    ];
    for (const p of perms) {
      const status = await runGuard(ownerId, 'owner', p);
      expect(status).toBe(200);
    }
  });

  test('NEGATIVE: الـ Viewer مرفوض من كل صلاحيات sales_orders.* التنفيذية (403)', async () => {
    const forbidden = [
      PERMISSIONS.SALES_ORDERS_CREATE,
      PERMISSIONS.SALES_ORDERS_EDIT_DRAFT,
      PERMISSIONS.SALES_ORDERS_CONFIRM,
      PERMISSIONS.SALES_ORDERS_PROCESS,
      PERMISSIONS.SALES_ORDERS_SHIP,
      PERMISSIONS.SALES_ORDERS_DELIVER,
      PERMISSIONS.SALES_ORDERS_APPROVE,
      PERMISSIONS.SALES_ORDERS_REJECT,
      PERMISSIONS.SALES_ORDERS_CLOSE,
      PERMISSIONS.SALES_ORDERS_CANCEL,
    ];
    for (const p of forbidden) {
      const status = await runGuard(viewerId, 'viewer', p);
      expect(status).toBe(403);
    }
  });

  test('POSITIVE: الـ Viewer يمر بصلاحية sales_orders.view (200)', async () => {
    const status = await runGuard(viewerId, 'viewer', PERMISSIONS.SALES_ORDERS_VIEW);
    expect(status).toBe(200);
  });

  test('POSITIVE: الـ Manager يمر بكل صلاحيات sales_orders.* التشغيلية (200)', async () => {
    const perms = [
      PERMISSIONS.SALES_ORDERS_VIEW,
      PERMISSIONS.SALES_ORDERS_CREATE,
      PERMISSIONS.SALES_ORDERS_EDIT_DRAFT,
      PERMISSIONS.SALES_ORDERS_CONFIRM,
      PERMISSIONS.SALES_ORDERS_PROCESS,
      PERMISSIONS.SALES_ORDERS_SHIP,
      PERMISSIONS.SALES_ORDERS_DELIVER,
      PERMISSIONS.SALES_ORDERS_CLOSE,
      PERMISSIONS.SALES_ORDERS_CANCEL,
    ];
    for (const p of perms) {
      const status = await runGuard(managerId, 'manager', p);
      expect(status).toBe(200);
    }
  });

  test('NEGATIVE: الـ Manager مرفوض من صلاحيات الإدارة العليا (403)', async () => {
    const forbidden = ['users.manage', 'roles.edit', 'roles.view', 'users.view'];
    for (const p of forbidden) {
      const status = await runGuard(managerId, 'manager', p);
      expect(status).toBe(403);
    }
  });

  test('NEGATIVE: الـ Manager مرفوض من sales_orders.approve و sales_orders.reject (Owner فقط)', async () => {
    const forbidden = [PERMISSIONS.SALES_ORDERS_APPROVE, PERMISSIONS.SALES_ORDERS_REJECT];
    for (const p of forbidden) {
      const status = await runGuard(managerId, 'manager', p);
      expect(status).toBe(403);
    }
  });

  test('NEGATIVE: الـ Viewer مرفوض من صلاحيات المخزون التنفيذية (403)', async () => {
    const forbidden = [
      'products.create',
      'products.edit',
      'products.delete',
      'stocktake.create',
      'stocktake.approve',
      'permits.withdraw',
      'permits.supply',
      'clients.create',
      'clients.edit',
      'clients.delete',
      'suppliers.create',
    ];
    for (const p of forbidden) {
      const status = await runGuard(viewerId, 'viewer', p);
      expect(status).toBe(403);
    }
  });

  test('NEGATIVE: الـ Owner bypass ملغي — بدون الصلاحية في DB = 403', async () => {
    await testPrisma.roleConfig.update({
      where: { name: 'owner' },
      data: { permissions: JSON.stringify([PERMISSIONS.PRODUCTS_VIEW]) },
    });
    const status = await runGuard(ownerId, 'owner', PERMISSIONS.SALES_ORDERS_VIEW);
    expect(status).toBe(403);
  });

  test('NEGATIVE: Custom Role (isSystem=false) لا يُلمس من الـ upsert', async () => {
    const custom = await testPrisma.roleConfig.create({
      data: {
        name: 'cashier',
        displayName: 'كاشير',
        description: 'دور مخصص',
        permissions: JSON.stringify([PERMISSIONS.PRODUCTS_VIEW]),
        isSystem: false,
      },
    });
    await upsertDefaultRoles(testPrisma);
    const after = await testPrisma.roleConfig.findUnique({ where: { id: custom.id } });
    expect(after!.permissions).toBe(JSON.stringify([PERMISSIONS.PRODUCTS_VIEW]));
    expect(after!.isSystem).toBe(false);
  });

  test('POSITIVE: Custom Role يستطيع العمل بصلاحياته (200)', async () => {
    const custom = await testPrisma.roleConfig.create({
      data: {
        name: 'cashier2',
        displayName: 'كاشير 2',
        description: 'دور مخصص',
        permissions: JSON.stringify([PERMISSIONS.SALES_ORDERS_VIEW]),
        isSystem: false,
      },
    });
    const user = await testPrisma.user.create({
      data: {
        email: `cashier-${Date.now()}@x.com`,
        password: 'hash',
        firstName: 'C',
        lastName: 'A',
        role: 'cashier2',
        roleId: custom.id,
      },
    });
    const status = await runGuard(user.id, 'cashier2', PERMISSIONS.SALES_ORDERS_VIEW);
    expect(status).toBe(200);
  });

  test('POSITIVE: Emergency bypass متاح إذا فُعِّل صراحةً في env', async () => {
    const prev = process.env.PERMISSION_EMERGENCY_BYPASS;
    process.env.PERMISSION_EMERGENCY_BYPASS = 'true';
    try {
      const status = await runGuard(ownerId, 'owner', PERMISSIONS.SALES_ORDERS_VIEW);
      expect(status).toBe(200);
    } finally {
      if (prev === undefined) delete process.env.PERMISSION_EMERGENCY_BYPASS;
      else process.env.PERMISSION_EMERGENCY_BYPASS = prev;
    }
  });

  test('POSITIVE: الـ Owner يمر بكل صلاحيات returns.* (200)', async () => {
    const perms = [
      PERMISSIONS.RETURNS_VIEW,
      PERMISSIONS.RETURNS_CREATE,
      PERMISSIONS.RETURNS_APPROVE,
      PERMISSIONS.RETURNS_RECEIVE,
      PERMISSIONS.RETURNS_REJECT,
      PERMISSIONS.RETURNS_CLOSE,
      PERMISSIONS.RETURNS_REFUND,
    ];
    for (const p of perms) {
      const status = await runGuard(ownerId, 'owner', p);
      expect(status).toBe(200);
    }
  });

  test('POSITIVE: الـ Manager يمر بصلاحيات returns.* التشغيلية (200)', async () => {
    const perms = [
      PERMISSIONS.RETURNS_VIEW,
      PERMISSIONS.RETURNS_CREATE,
      PERMISSIONS.RETURNS_RECEIVE,
      PERMISSIONS.RETURNS_CLOSE,
    ];
    for (const p of perms) {
      const status = await runGuard(managerId, 'manager', p);
      expect(status).toBe(200);
    }
  });

  test('NEGATIVE: الـ Manager مرفوض من returns.approve و returns.reject و returns.refund (403)', async () => {
    const forbidden = [
      PERMISSIONS.RETURNS_APPROVE,
      PERMISSIONS.RETURNS_REJECT,
      PERMISSIONS.RETURNS_REFUND,
    ];
    for (const p of forbidden) {
      const status = await runGuard(managerId, 'manager', p);
      expect(status).toBe(403);
    }
  });

  test('POSITIVE: الـ Viewer يمر بصلاحية returns.view (200)', async () => {
    const status = await runGuard(viewerId, 'viewer', PERMISSIONS.RETURNS_VIEW);
    expect(status).toBe(200);
  });

  test('NEGATIVE: الـ Viewer مرفوض من كل صلاحيات returns.* التنفيذية (403)', async () => {
    const forbidden = [
      PERMISSIONS.RETURNS_CREATE,
      PERMISSIONS.RETURNS_APPROVE,
      PERMISSIONS.RETURNS_RECEIVE,
      PERMISSIONS.RETURNS_REJECT,
      PERMISSIONS.RETURNS_CLOSE,
      PERMISSIONS.RETURNS_REFUND,
    ];
    for (const p of forbidden) {
      const status = await runGuard(viewerId, 'viewer', p);
      expect(status).toBe(403);
    }
  });
});
