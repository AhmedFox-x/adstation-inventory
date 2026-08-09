import { prisma } from '../schema/helpers';
import { cleanDb } from '../schema/fixtures';
import { upsertDefaultRoles } from '../../src/utils/seedRoles';
import {
  DEFAULT_ROLES,
  ALL_PERMISSIONS,
  PERMISSIONS,
} from '../../src/utils/permissions';

describe('Roles Seed & Sales Orders Permissions', () => {
  beforeEach(async () => {
    await cleanDb();
  });

  afterAll(async () => {
    await cleanDb();
  });

  function permsOf(name: string): string[] {
    return DEFAULT_ROLES[name].permissions;
  }

  test('upsert: ينشئ كل الأدوار من الصفر عند عدم وجودها', async () => {
    const result = await upsertDefaultRoles(prisma);
    expect(result.created.sort()).toEqual(['manager', 'owner', 'viewer']);
    expect(result.updated).toEqual([]);

    const roles = await prisma.roleConfig.findMany();
    expect(roles.length).toBe(3);
  });

  test('upsert: الأدوار المدمجة تُنشأ بـ isSystem=true', async () => {
    await upsertDefaultRoles(prisma);
    const roles = await prisma.roleConfig.findMany();
    for (const r of roles) {
      expect(r.isSystem).toBe(true);
    }
  });

  test('upsert: لا يلمس Custom Role (isSystem=false) إطلاقًا', async () => {
    await prisma.roleConfig.create({
      data: {
        name: 'cashier',
        displayName: 'كاشير',
        description: 'دور مخصص',
        permissions: JSON.stringify(['products.view']),
        isSystem: false,
      },
    });

    const result = await upsertDefaultRoles(prisma);
    expect(result.created).not.toContain('cashier');
    expect(result.updated).not.toContain('cashier');

    const cashier = await prisma.roleConfig.findUnique({ where: { name: 'cashier' } });
    expect(JSON.parse(cashier!.permissions)).toEqual(['products.view']);
    expect(cashier!.isSystem).toBe(false);
  });

  test('upsert: Custom Role بنفس اسم دور مدمج لا يُضاف ولا يُعدَّل (لو isSystem=false)', async () => {
    // سيناريو: دور اسمه "owner" موجود لكن isSystem=false (تمسّخ يدوي)
    await prisma.roleConfig.create({
      data: {
        name: 'owner',
        displayName: 'مالك معدّل يدويًا',
        permissions: JSON.stringify(['products.view']),
        isSystem: false,
      },
    });

    const result = await upsertDefaultRoles(prisma);
    expect(result.updated).not.toContain('owner');

    const owner = await prisma.roleConfig.findUnique({ where: { name: 'owner' } });
    expect(JSON.parse(owner!.permissions)).toEqual(['products.view']);
  });

  test('upsert: دور مدمج تعدّل يدويًا (isSystem=false) لا يُلمس ولا يُعاد ضبطه', async () => {
    // سيناريو: دور اسمه "manager" موجود لكن isSystem=false (حوّله المستخدم لدور مخصص)
    await prisma.roleConfig.create({
      data: {
        name: 'manager',
        displayName: 'مدير معدّل يدويًا',
        permissions: JSON.stringify(['products.view']),
        isSystem: false,
      },
    });

    const result = await upsertDefaultRoles(prisma);
    expect(result.updated).not.toContain('manager');

    const manager = await prisma.roleConfig.findUnique({ where: { name: 'manager' } });
    expect(manager!.isSystem).toBe(false);
    expect(JSON.parse(manager!.permissions)).toEqual(['products.view']);
  });

  test('upsert: يحدّث الدور القديم الناقص صلاحيات sales_orders (سيناريو prod القديم)', async () => {
    // محاكاة الحالة القديمة في prod: owner بـ 35 صلاحية قديمة من غير sales_orders
    await prisma.roleConfig.create({
      data: {
        name: 'owner',
        displayName: 'المالك',
        permissions: JSON.stringify([
          'products.view', 'products.create', 'products.edit', 'products.delete',
          'permits.withdraw', 'permits.supply', 'scan.use', 'logs.view',
          'stocktake.create', 'stocktake.approve', 'reports.view', 'reports.export',
          'users.view', 'users.manage', 'roles.view', 'roles.edit',
          'suppliers.view', 'suppliers.create', 'suppliers.edit', 'suppliers.delete',
          'purchase_orders.view', 'purchase_orders.create', 'purchase_orders.edit',
          'purchase_orders.receive', 'clients.view', 'clients.create', 'clients.edit',
          'clients.delete', 'products.import', 'products.export', 'reservations.view',
          'reservations.create', 'reservations.edit', 'reservations.cancel',
          'reservations.fulfill',
        ]),
      },
    });

    const result = await upsertDefaultRoles(prisma);
    expect(result.updated).toContain('owner');

    const owner = await prisma.roleConfig.findUnique({ where: { name: 'owner' } });
    const perms: string[] = JSON.parse(owner!.permissions);
    // owner لازم ياخد ALL_PERMISSIONS كاملة (بما فيها كل sales_orders.*)
    for (const p of ALL_PERMISSIONS) {
      expect(perms).toContain(p);
    }
    expect(perms.length).toBe(ALL_PERMISSIONS.length);
  });

  test('upsert: idempotent — التشغيل التاني لا يحدّث شيئًا (مفيش تغيير)', async () => {
    await upsertDefaultRoles(prisma);
    const second = await upsertDefaultRoles(prisma);
    expect(second.updated).toEqual([]);
    expect(second.created).toEqual([]);
  });

  test('الـ owner عنده كل الصلاحيات (ALL_PERMISSIONS)', async () => {
    await upsertDefaultRoles(prisma);
    const owner = await prisma.roleConfig.findUnique({ where: { name: 'owner' } });
    const perms: string[] = JSON.parse(owner!.permissions);
    expect(perms.length).toBe(ALL_PERMISSIONS.length);
    for (const p of ALL_PERMISSIONS) {
      expect(perms).toContain(p);
    }
  });

  test('الـ manager عنده كل الصلاحيات التشغيلية لـ sales_orders.*', async () => {
    await upsertDefaultRoles(prisma);
    const manager = await prisma.roleConfig.findUnique({ where: { name: 'manager' } });
    const perms: string[] = JSON.parse(manager!.permissions);

    const operational = [
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
    for (const p of operational) {
      expect(perms).toContain(p);
    }
  });

  test('الـ manager مش عنده صلاحيات الإدارة العليا (users.manage, roles.edit)', async () => {
    await upsertDefaultRoles(prisma);
    const manager = await prisma.roleConfig.findUnique({ where: { name: 'manager' } });
    const perms: string[] = JSON.parse(manager!.permissions);

    expect(perms).not.toContain('users.manage');
    expect(perms).not.toContain('roles.edit');
    expect(perms).not.toContain('roles.view');
    expect(perms).not.toContain('users.view');
  });

  test('الـ viewer عنده sales_orders.view فقط (عرض، مش تنفيذ)', async () => {
    await upsertDefaultRoles(prisma);
    const viewer = await prisma.roleConfig.findUnique({ where: { name: 'viewer' } });
    const perms: string[] = JSON.parse(viewer!.permissions);

    expect(perms).toContain('sales_orders.view');
    expect(perms).not.toContain('sales_orders.create');
    expect(perms).not.toContain('sales_orders.confirm');
    expect(perms).not.toContain('sales_orders.deliver');
  });

  test('الـ viewer مش عنده أي صلاحية من صلاحيات المخزون التنفيذية', async () => {
    await upsertDefaultRoles(prisma);
    const viewer = await prisma.roleConfig.findUnique({ where: { name: 'viewer' } });
    const perms: string[] = JSON.parse(viewer!.permissions);

    expect(perms).not.toContain('products.create');
    expect(perms).not.toContain('products.edit');
    expect(perms).not.toContain('products.delete');
    expect(perms).not.toContain('stocktake.create');
    expect(perms).not.toContain('stocktake.approve');
    expect(perms).not.toContain('permits.withdraw');
    expect(perms).not.toContain('permits.supply');
  });

  test('DEFAULT_ROLES متطابق مع PERMISSIONS (لا صلاحيات غير معروفة)', async () => {
    const known = new Set<string>(ALL_PERMISSIONS);
    for (const [name, role] of Object.entries(DEFAULT_ROLES)) {
      for (const p of role.permissions) {
        expect(known.has(p)).toBe(true);
      }
    }
  });

  test('لا توجد صلاحية logs.delete (ممنوعة نهائيًا حسب AGENT.md)', async () => {
    expect(ALL_PERMISSIONS).not.toContain('logs.delete');
    expect(permsOf('owner')).not.toContain('logs.delete');
    expect(permsOf('manager')).not.toContain('logs.delete');
    expect(permsOf('viewer')).not.toContain('logs.delete');
  });

  test('كل صلاحيات sales_orders.* مدرجة في الـ PERMISSIONS object', async () => {
    const expected = [
      'sales_orders.view',
      'sales_orders.create',
      'sales_orders.edit_draft',
      'sales_orders.confirm',
      'sales_orders.process',
      'sales_orders.ship',
      'sales_orders.deliver',
      'sales_orders.approve',
      'sales_orders.reject',
      'sales_orders.close',
      'sales_orders.cancel',
    ];
    for (const p of expected) {
      expect(ALL_PERMISSIONS).toContain(p);
    }
  });

  test('الـ owner في DB مطابق تمامًا لـ ALL_PERMISSIONS بعد الـ upsert (Positive)', async () => {
    await upsertDefaultRoles(prisma);
    const owner = await prisma.roleConfig.findUnique({ where: { name: 'owner' } });
    const perms: string[] = JSON.parse(owner!.permissions).sort();
    expect(perms).toEqual([...ALL_PERMISSIONS].sort());
  });

  test('كل صلاحيات returns.* مدرجة في الـ PERMISSIONS object', async () => {
    const expected = [
      'returns.view',
      'returns.create',
      'returns.approve',
      'returns.receive',
      'returns.reject',
      'returns.close',
      'returns.refund',
    ];
    for (const p of expected) {
      expect(ALL_PERMISSIONS).toContain(p);
    }
  });

  test('الـ manager عنده الصلاحيات التشغيلية لـ returns.* (Positive)', async () => {
    await upsertDefaultRoles(prisma);
    const manager = await prisma.roleConfig.findUnique({ where: { name: 'manager' } });
    const perms: string[] = JSON.parse(manager!.permissions);

    const operational = [
      PERMISSIONS.RETURNS_VIEW,
      PERMISSIONS.RETURNS_CREATE,
      PERMISSIONS.RETURNS_RECEIVE,
      PERMISSIONS.RETURNS_CLOSE,
    ];
    for (const p of operational) {
      expect(perms).toContain(p);
    }
  });

  test('الـ manager مش عنده صلاحيات القرار العليا لـ returns.* (Negative)', async () => {
    await upsertDefaultRoles(prisma);
    const manager = await prisma.roleConfig.findUnique({ where: { name: 'manager' } });
    const perms: string[] = JSON.parse(manager!.permissions);

    expect(perms).not.toContain('returns.approve');
    expect(perms).not.toContain('returns.reject');
    expect(perms).not.toContain('returns.refund');
  });

  test('الـ viewer عنده returns.view فقط (Positive + Negative معًا)', async () => {
    await upsertDefaultRoles(prisma);
    const viewer = await prisma.roleConfig.findUnique({ where: { name: 'viewer' } });
    const perms: string[] = JSON.parse(viewer!.permissions);

    expect(perms).toContain('returns.view');
    expect(perms).not.toContain('returns.create');
    expect(perms).not.toContain('returns.approve');
    expect(perms).not.toContain('returns.receive');
    expect(perms).not.toContain('returns.reject');
    expect(perms).not.toContain('returns.close');
    expect(perms).not.toContain('returns.refund');
  });
});
