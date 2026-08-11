import http from 'http';
import express from 'express';
import jwt from 'jsonwebtoken';
import { AddressInfo } from 'net';
import dashboardRouter from '../../src/routes/dashboard';
import { prisma as testPrisma } from '../schema/helpers';
import { cleanDb } from '../schema/fixtures';

const JWT_SECRET = 'test-dashboard-secret';

function makeToken(userId: string, role = 'manager'): string {
  return jwt.sign({ userId, email: `${userId}@x.com`, name: 'Dashboard User', role }, JWT_SECRET);
}

const VIEWER_PERMS = ['reports.view'];
const NO_PERMS: string[] = [];

describe('P6 Dashboard endpoint (KPIs + 30-day series + categories)', () => {
  let server: http.Server;
  let base: string;
  let viewer: string;
  let noPerms: string;

  beforeAll(async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    const app = express();
    app.use(express.json());
    app.use('/api/inventory', dashboardRouter);
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/inventory`;
  });

  beforeEach(async () => {
    await cleanDb();
    viewer = await createUserWithPerms('viewer', VIEWER_PERMS);
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
    return { status: res.status, json };
  }

  function createProduct(overrides: any = {}) {
    return testPrisma.product.create({
      data: {
        name: overrides.name || 'P' + Math.random().toString(36).slice(2, 8),
        stock: overrides.stock ?? 0,
        minStock: overrides.minStock ?? 5,
        price: overrides.price ?? 0,
        category: overrides.category ?? null,
        ...(overrides.deletedAt !== undefined ? { deletedAt: overrides.deletedAt } : {}),
      },
    });
  }

  function createLog(overrides: any = {}) {
    return testPrisma.inventoryLog.create({
      data: {
        type: overrides.type || 'supply',
        productId: overrides.productId,
        oldStock: overrides.oldStock ?? 0,
        newStock: overrides.newStock ?? 10,
        change: overrides.change ?? 10,
        createdAt: overrides.createdAt || new Date(),
      },
    });
  }

  test('401 when no token provided', async () => {
    const res = await api('GET', '/dashboard');
    expect(res.status).toBe(401);
  });

  test('403 when user lacks reports.view', async () => {
    const res = await api('GET', '/dashboard', makeToken(noPerms));
    expect(res.status).toBe(403);
  });

  test('200 returns all dashboard sections for reports.view user', async () => {
    const p = await createProduct({ stock: 10, price: 50, minStock: 5, category: 'كبايات' });
    await createLog({ productId: p.id, change: 10, oldStock: 0, newStock: 10, type: 'supply' });

    const res = await api('GET', '/dashboard', makeToken(viewer));
    expect(res.status).toBe(200);

    expect(res.json).toHaveProperty('kpis');
    expect(res.json.kpis.totalProducts).toBe(1);
    expect(res.json.kpis.totalItems).toBe(10);
    expect(res.json.kpis.totalValue).toBe(500);
    expect(res.json.kpis.productsWithoutPrice).toBe(0);
    expect(res.json.kpis.todayMoves).toBe(1);
    expect(res.json.kpis.todayUpQty).toBe(10);

    expect(res.json.series).toHaveLength(30);
    expect(res.json.byCategory).toHaveLength(1);
    expect(res.json.byCategory[0]).toMatchObject({ category: 'كبايات', value: 500, count: 1, stock: 10 });
    expect(res.json.topMovers[0]).toMatchObject({ moved: 10 });
    expect(res.json.topValue[0]).toMatchObject({ value: 500 });
    expect(res.json.recentLogs).toHaveLength(1);
    expect(res.json.abc).toHaveProperty('A');
  });

  test('archived products excluded from KPIs, categories, movers and low-stock', async () => {
    const active = await createProduct({ stock: 8, price: 100, minStock: 10, category: 'نشط' });
    const archived = await createProduct({ stock: 100, price: 1000, minStock: 5, category: 'مؤرشف', deletedAt: new Date() });
    await createLog({ productId: active.id, change: 8, type: 'supply' });
    await createLog({ productId: archived.id, change: 100, type: 'supply' });

    const res = await api('GET', '/dashboard', makeToken(viewer));
    expect(res.status).toBe(200);

    // Archived product excluded entirely
    expect(res.json.kpis.totalProducts).toBe(1);
    expect(res.json.kpis.totalItems).toBe(8);
    expect(res.json.kpis.totalValue).toBe(800);
    expect(res.json.kpis.todayUpQty).toBe(8);

    // Categories only from active products
    const cats = res.json.byCategory.map((c: any) => c.category);
    expect(cats).toContain('نشط');
    expect(cats).not.toContain('مؤرشف');

    // Movers reference only active products
    const moverNames = res.json.topMovers.map((m: any) => m.name);
    expect(moverNames.length).toBeGreaterThan(0);
    expect(moverNames).not.toContain(null);
  });

  test('low-stock and out-of-stock and without-price KPIs computed correctly', async () => {
    await createProduct({ stock: 3, minStock: 10, price: 20 }); // low
    await createProduct({ stock: 0, minStock: 5, price: 10 });  // out
    await createProduct({ stock: 15, minStock: 5, price: 0 });  // no price
    await createProduct({ stock: 50, minStock: 5, price: 30 }); // fine

    const res = await api('GET', '/dashboard', makeToken(viewer));
    expect(res.status).toBe(200);
    expect(res.json.kpis.totalProducts).toBe(4);
    expect(res.json.kpis.lowStock).toBe(1);
    expect(res.json.kpis.outOfStock).toBe(1);
    expect(res.json.kpis.productsWithoutPrice).toBe(1);
    expect(res.json.lowStock).toHaveLength(1);
    expect(res.json.lowStock[0]).toMatchObject({ stock: 3, minStock: 10 });
  });

  test('zero-filled 30-day series has correct total and sums', async () => {
    const p = await createProduct({ stock: 5, price: 10 });
    await createLog({ productId: p.id, change: 3, type: 'supply' });
    await createLog({ productId: p.id, change: -2, oldStock: 3, newStock: 1, type: 'withdraw' });

    const res = await api('GET', '/dashboard', makeToken(viewer));
    expect(res.status).toBe(200);
    expect(res.json.series).toHaveLength(30);

    const todayKey = new Date().toISOString().slice(0, 10);
    const todayBucket = res.json.series.find((s: any) => s.date === todayKey);
    expect(todayBucket).toBeDefined();
    expect(todayBucket.up).toBe(3);
    expect(todayBucket.down).toBe(2);
    expect(todayBucket.moves).toBe(2);
  });
});
