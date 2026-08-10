import http from 'http';
import express from 'express';
import jwt from 'jsonwebtoken';
import { AddressInfo } from 'net';
import productsRouter from '../../src/routes/products';
import { prisma as testPrisma } from '../schema/helpers';
import { cleanDb } from '../schema/fixtures';

const JWT_SECRET = 'test-products-secret';

function makeToken(userId: string): string {
  return jwt.sign({ userId, email: `${userId}@x.com`, name: 'Test Manager', role: 'manager' }, JWT_SECRET);
}

const PERMS = ['products.view', 'products.create', 'products.edit', 'products.delete'];

describe('P5 Products soft delete (archived)', () => {
  let server: http.Server;
  let base: string;
  let token: string;

  beforeAll(async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    const app = express();
    app.use(express.json());
    app.use('/api/inventory', productsRouter);
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/inventory`;
  });

  beforeEach(async () => {
    await cleanDb();
    const role = await testPrisma.roleConfig.create({
      data: {
        name: `mgr-${Date.now()}`,
        displayName: 'Manager',
        permissions: JSON.stringify(PERMS),
        isSystem: false,
      },
    });
    const user = await testPrisma.user.create({
      data: {
        email: `m-${Date.now()}@x.com`,
        password: 'hash',
        firstName: 'M',
        lastName: 'U',
        role: 'manager',
        roleId: role.id,
      },
    });
    token = makeToken(user.id);
  });

  afterAll(async () => {
    await cleanDb();
    await new Promise<void>((resolve, reject) => server.close((e: any) => (e ? reject(e) : resolve())));
  });

  async function api(method: string, path: string, auth?: boolean, body?: any) {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(auth !== false ? { Authorization: `Bearer ${token}` } : {}),
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json: any = await res.json().catch(() => null);
    return { status: res.status, json };
  }

  test('DELETE /products/:id يؤرشف المنتج (deletedAt) ويحفظ السجل بالكامل', async () => {
    const p = await testPrisma.product.create({ data: { name: 'منتج', stock: 10 } });
    await testPrisma.inventoryLog.create({
      data: { type: 'supply', productId: p.id, oldStock: 0, newStock: 10, change: 10 },
    });

    const { status, json } = await api('DELETE', `/products/${p.id}`);
    expect(status).toBe(200);
    expect(json).toMatchObject({ message: 'Product archived', archived: true });

    const archived = await testPrisma.product.findUnique({ where: { id: p.id } });
    expect(archived!.deletedAt).toBeInstanceOf(Date);

    const logs = await testPrisma.inventoryLog.count({ where: { productId: p.id } });
    expect(logs).toBe(1);
  });

  test('DELETE لمنتج مؤرشف بالفعل يرفض بـ 409', async () => {
    const p = await testPrisma.product.create({ data: { name: 'منتج', stock: 10, deletedAt: new Date() } });
    const { status } = await api('DELETE', `/products/${p.id}`);
    expect(status).toBe(409);
  });

  test('DELETE لمنتج غير موجود يرد 404', async () => {
    const { status } = await api('DELETE', `/products/nonexistent-id`);
    expect(status).toBe(404);
  });

  test('PATCH لمنتج مؤرشف يرفض بـ 403 (Negative) — والمنتج النشط يعدل بنجاح (Positive)', async () => {
    const archivedP = await testPrisma.product.create({ data: { name: 'مؤرشف', stock: 10, deletedAt: new Date() } });
    const archivedRes = await api('PATCH', `/products/${archivedP.id}`, true, { name: 'محاولة تعديل' });
    expect(archivedRes.status).toBe(403);

    const activeP = await testPrisma.product.create({ data: { name: 'نشط', stock: 10 } });
    const activeRes = await api('PATCH', `/products/${activeP.id}`, true, { name: 'تم تعديله' });
    expect(activeRes.status).toBe(200);
    expect(activeRes.json.product.name).toBe('تم تعديله');
  });

  test('PATCH بتغيير الكمية يسجل Log من نوع manual_adjust بكل حقول التدقيق', async () => {
    const p = await testPrisma.product.create({ data: { name: 'منتج', stock: 10 } });

    const { status } = await api('PATCH', `/products/${p.id}`, true, { stock: 15 });
    expect(status).toBe(200);

    const log = await testPrisma.inventoryLog.findFirst({
      where: { productId: p.id, type: 'manual_adjust' },
    });
    expect(log).not.toBeNull();
    expect(log!.userId).toBeTruthy();
    expect(log!.userName).toBe('Test Manager');
    expect(log!.userRole).toBe('manager');
    expect(log!.entityType).toBe('product');
    expect(log!.entityId).toBe(p.id);
    expect(log!.oldStock).toBe(10);
    expect(log!.newStock).toBe(15);
    expect(log!.change).toBe(5);
    expect(log!.beforeData).toEqual({ stock: 10, minStock: 5, price: 0 });
    expect(log!.afterData).toEqual({ stock: 15, minStock: 5, price: 0 });
  });

  test('GET /products يستبعد المؤرشف افتراضياً ويتضمنه مع archived=true', async () => {
    const active = await testPrisma.product.create({ data: { name: 'نشط', stock: 5 } });
    const archived = await testPrisma.product.create({ data: { name: 'مؤرشف', stock: 3, deletedAt: new Date() } });

    const def = await api('GET', `/products?limit=100`);
    expect(def.status).toBe(200);
    const defaultIds = def.json.products.map((x: any) => x.id);
    expect(defaultIds).toContain(active.id);
    expect(defaultIds).not.toContain(archived.id);

    const all = await api('GET', `/products?limit=100&archived=true`);
    const allIds = all.json.products.map((x: any) => x.id);
    expect(allIds).toContain(active.id);
    expect(allIds).toContain(archived.id);
  });

  test('uniqueness SKU: إنشاء منتج جديد بنفس SKU منتج مؤرشف يرفض 409', async () => {
    const archived = await testPrisma.product.create({ data: { name: 'مؤرشف', stock: 3, sku: 'SKU-X', deletedAt: new Date() } });
    expect(archived.sku).toBe('SKU-X');

    const { status } = await api('POST', `/products`, true, { name: 'جديد', sku: 'SKU-X' });
    expect(status).toBe(409);
  });
});
