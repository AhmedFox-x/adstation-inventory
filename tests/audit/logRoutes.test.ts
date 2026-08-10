import http from 'http';
import express from 'express';
import jwt from 'jsonwebtoken';
import { AddressInfo } from 'net';
import logRouter from '../../src/routes/log';
import { prisma as testPrisma } from '../schema/helpers';
import { cleanDb } from '../schema/fixtures';

const JWT_SECRET = 'test-log-secret';

function makeToken(userId: string, role = 'manager'): string {
  return jwt.sign({ userId, email: `${userId}@x.com`, name: 'Auditor', role }, JWT_SECRET);
}

const VIEWER_PERMS = ['logs.view', 'reports.view'];
const EXPORT_PERMS = ['logs.view', 'reports.view', 'reports.export'];
const NO_PERMS: string[] = [];

describe('P5 Log routes (filters / pagination / export / audit fields)', () => {
  let server: http.Server;
  let base: string;
  let withExport: string;
  let withoutExport: string;
  let noPerms: string;

  beforeAll(async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    const app = express();
    app.use(express.json());
    app.use('/api/inventory', logRouter);
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/inventory`;
  });

  beforeEach(async () => {
    await cleanDb();
    withExport = await createUserWithPerms('viewer', EXPORT_PERMS);
    withoutExport = await createUserWithPerms('viewer', VIEWER_PERMS);
    noPerms = await createUserWithPerms('viewer', NO_PERMS);
  });

  async function createUserWithPerms(role: string, perms: string[]): Promise<string> {
    const rc = await testPrisma.roleConfig.create({
      data: {
        name: `role-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        displayName: role,
        permissions: JSON.stringify(perms),
        isSystem: false,
      },
    });
    const user = await testPrisma.user.create({
      data: {
        email: `u-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@x.com`,
        password: 'hash',
        firstName: 'U',
        lastName: 'Ser',
        role,
        roleId: rc.id,
      },
    });
    return user.id;
  }

  afterAll(async () => {
    await cleanDb();
    await new Promise<void>((resolve, reject) => server.close((e: any) => (e ? reject(e) : resolve())));
  });

  async function api(method: string, path: string, token?: string, body?: any) {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json: any = await res.json().catch(() => null);
    return { status: res.status, json, text: () => res.text() };
  }

  async function seedLogs() {
    const p1 = await testPrisma.product.create({ data: { name: 'منتج أول', stock: 20 } });
    const p2 = await testPrisma.product.create({ data: { name: 'منتج ثاني', stock: 30 } });
    const actor = await testPrisma.user.create({
      data: { email: `actor-${Date.now()}@x.com`, password: 'hash', firstName: 'A', lastName: 'B', role: 'manager' },
    });
    const l1 = await testPrisma.inventoryLog.create({
      data: {
        type: 'manual_adjust',
        productId: p1.id,
        oldStock: 20,
        newStock: 18,
        change: -2,
        userId: actor.id,
        userName: 'Actor Name',
        userRole: 'manager',
        entityType: 'product',
        entityId: p1.id,
        beforeData: { stock: 20 },
        afterData: { stock: 18 },
      },
    });
    const l2 = await testPrisma.inventoryLog.create({
      data: {
        type: 'supply',
        productId: p2.id,
        oldStock: 20,
        newStock: 30,
        change: 10,
        userId: withExport,
        userName: 'Exporter',
        userRole: 'viewer',
        entityType: 'purchase_order',
        entityId: 'po-1',
      },
    });
    return { p1, p2, actor, l1, l2 };
  }

  test('GET /log بدون توكن يرد 401', async () => {
    const { status } = await api('GET', '/log');
    expect(status).toBe(401);
  });

  test('GET /log بدون صلاحية logs.view يرد 403 (Negative) — وبدونها مع صلاحية يرد 200 (Positive)', async () => {
    const denied = await api('GET', '/log', makeToken(noPerms));
    expect(denied.status).toBe(403);

    const allowed = await api('GET', '/log', makeToken(withExport));
    expect(allowed.status).toBe(200);
  });

  test('GET /log يرجع حقول التدقيق الجديدة + كائن pagination', async () => {
    const { p1 } = await seedLogs();
    const res = await api('GET', '/log', makeToken(withExport));
    expect(res.status).toBe(200);
    expect(res.json.pagination).toMatchObject({ page: 1, limit: 20, total: 2, pages: 1 });

    const entry = res.json.logs.find((l: any) => l.entityType === 'product');
    expect(entry).toMatchObject({
      productId: p1.id,
      type: 'manual_adjust',
      userId: expect.any(String),
      userName: 'Actor Name',
      userRole: 'manager',
      entityType: 'product',
      entityId: p1.id,
    });
    expect(entry.beforeData).toEqual({ stock: 20 });
    expect(entry.afterData).toEqual({ stock: 18 });
  });

  test('GET /log?entityType= و ?userId= و ?type= يفلتر بدقة', async () => {
    const { actor, l2 } = await seedLogs();

    const byEntity = await api('GET', `/log?entityType=purchase_order`, makeToken(withExport));
    expect(byEntity.status).toBe(200);
    expect(byEntity.json.pagination.total).toBe(1);
    expect(byEntity.json.logs[0].id).toBe(l2.id);

    const byUser = await api('GET', `/log?userId=${actor.id}`, makeToken(withExport));
    expect(byUser.status).toBe(200);
    expect(byUser.json.pagination.total).toBe(1);
    expect(byUser.json.logs[0].userName).toBe('Actor Name');

    const byType = await api('GET', `/log?type=supply`, makeToken(withExport));
    expect(byType.status).toBe(200);
    expect(byType.json.pagination.total).toBe(1);
    expect(byType.json.logs[0].type).toBe('supply');
  });

  test('GET /log يقيد الـ pagination (limit يُقص إلى 200 و page لا يقل عن 1)', async () => {
    const products = [];
    for (let i = 0; i < 5; i++) {
      const p = await testPrisma.product.create({ data: { name: `p-${i}`, stock: i + 1 } });
      await testPrisma.inventoryLog.create({
        data: { type: 'supply', productId: p.id, oldStock: 0, newStock: i + 1, change: i + 1 },
      });
    }

    const clamped = await api('GET', `/log?limit=500&page=0`, makeToken(withExport));
    expect(clamped.status).toBe(200);
    expect(clamped.json.pagination.limit).toBe(200);
    expect(clamped.json.pagination.page).toBe(1);

    const paged = await api('GET', `/log?limit=2&page=2`, makeToken(withExport));
    expect(paged.status).toBe(200);
    expect(paged.json.pagination.limit).toBe(2);
    expect(paged.json.pagination.page).toBe(2);
  });

  test('GET /log/export يتطلب reports.export — 403 بدونها (Negative) و CSV معها (Positive)', async () => {
    const { l1 } = await seedLogs();

    const denied = await api('GET', '/log/export', makeToken(withoutExport));
    expect(denied.status).toBe(403);

    const res = await fetch(base + '/log/export', {
      headers: { Authorization: `Bearer ${makeToken(withExport)}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf[0]).toBe(0xef);
    expect(buf[1]).toBe(0xbb);
    expect(buf[2]).toBe(0xbf);
    const body = buf.toString('utf8');
    expect(body).toContain(l1.id);
    expect(body).toContain('entityType');
    expect(body).toContain('userRole');
  });

  test('GET /log/:id يرجع التفاصيل الكاملة بالتدقيق ويرد 404 لسجل غير موجود', async () => {
    const { p1, actor, l1 } = await seedLogs();

    const res = await api('GET', `/log/${l1.id}`, makeToken(withExport));
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      id: l1.id,
      productId: p1.id,
      type: 'manual_adjust',
      userId: actor.id,
      userName: 'Actor Name',
      userRole: 'manager',
      entityType: 'product',
      entityId: p1.id,
    });
    expect(res.json.beforeData).toEqual({ stock: 20 });
    expect(res.json.afterData).toEqual({ stock: 18 });

    const missing = await api('GET', `/log/nonexistent`, makeToken(withExport));
    expect(missing.status).toBe(404);
  });

  test('GET /report يرجع حقول التدقيق في details', async () => {
    const { p1 } = await seedLogs();
    const now = new Date();
    const localDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const res = await api('GET', `/report?date=${localDate}`, makeToken(withExport));
    expect(res.status).toBe(200);
    const detail = res.json.details.find((d: any) => d.productId === p1.id);
    expect(detail).toMatchObject({ entityType: 'product', entityId: p1.id, userName: 'Actor Name' });
    expect(typeof detail.userId).toBe('string');
  });
});
