import * as fs from 'fs';
import * as path from 'path';
import { prisma } from './helpers';
import { cleanDb } from './fixtures';

function collectTsFiles(dir: string, files: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      collectTsFiles(full, files);
    } else if (entry.name.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

describe('P5 Advanced Audit Trail — schema', () => {
  beforeEach(async () => {
    await cleanDb();
  });

  afterAll(async () => {
    await cleanDb();
  });

  test('InventoryLog يحمل حقول التدقيق (userId/userName/userRole/entityType/entityId/beforeData/afterData)', async () => {
    const product = await prisma.product.create({ data: { name: 'منتج', stock: 10 } });
    const log = await prisma.inventoryLog.create({
      data: {
        type: 'manual_adjust',
        productId: product.id,
        oldStock: 10,
        newStock: 5,
        change: -5,
        userId: 'u1',
        userName: 'مدير',
        userRole: 'manager',
        entityType: 'product',
        entityId: product.id,
        beforeData: { stock: 10, minStock: 5, price: 0 },
        afterData: { stock: 5, minStock: 5, price: 0 },
      },
    });

    const saved = await prisma.inventoryLog.findUnique({ where: { id: log.id } });
    expect(saved).toMatchObject({
      userId: 'u1',
      userName: 'مدير',
      userRole: 'manager',
      entityType: 'product',
      entityId: product.id,
    });
    expect(saved!.beforeData).toEqual({ stock: 10, minStock: 5, price: 0 });
    expect(saved!.afterData).toEqual({ stock: 5, minStock: 5, price: 0 });
  });

  test('أرشفة منتج تحفظ كل سجل حركته ولا تحذف أي صف (Append-Only + Soft Delete)', async () => {
    const product = await prisma.product.create({ data: { name: 'منتج', stock: 10 } });
    const l1 = await prisma.inventoryLog.create({
      data: { type: 'supply', productId: product.id, oldStock: 0, newStock: 10, change: 10 },
    });

    await prisma.product.update({ where: { id: product.id }, data: { deletedAt: new Date() } });

    const archived = await prisma.product.findUnique({ where: { id: product.id } });
    expect(archived!.deletedAt).toBeInstanceOf(Date);

    const remaining = await prisma.inventoryLog.count({ where: { productId: product.id } });
    expect(remaining).toBe(1);
    expect(await prisma.inventoryLog.findUnique({ where: { id: l1.id } })).not.toBeNull();
    expect(await prisma.product.findUnique({ where: { id: product.id } })).not.toBeNull();
  });

  test('InventoryLog له الفهارس الأربعة الجديدة', async () => {
    const rows = await prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'InventoryLog' AND schemaname = 'public'
    `;
    const names = rows.map((r) => r.indexname);
    expect(names).toContain('InventoryLog_userId_idx');
    expect(names).toContain('InventoryLog_entityType_entityId_idx');
    expect(names).toContain('InventoryLog_type_idx');
    expect(names).toContain('InventoryLog_createdAt_idx');
  });

  test('Append-Only: لا يوجد أي كود يحذف سجلات InventoryLog (delete/deleteMany)', () => {
    const srcDir = path.resolve(__dirname, '../../src');
    const offenders: string[] = [];
    for (const f of collectTsFiles(srcDir)) {
      const content = fs.readFileSync(f, 'utf8');
      if (/inventoryLog\.(delete|deleteMany)\b/.test(content)) {
        offenders.push(path.relative(srcDir, f));
      }
    }
    expect(offenders).toEqual([]);
  });

  test('حالة المؤرشف (deletedAt) تُحترم في استعلامات المنتجات التشغيلية', async () => {
    const active = await prisma.product.create({ data: { name: 'نشط', stock: 5 } });
    const archived = await prisma.product.create({ data: { name: 'مؤرشف', stock: 3 } });
    await prisma.product.update({ where: { id: archived.id }, data: { deletedAt: new Date() } });

    const activeOnly = await prisma.product.findMany({ where: { deletedAt: null } });
    const activeIds = activeOnly.map((p) => p.id);
    expect(activeIds).toContain(active.id);
    expect(activeIds).not.toContain(archived.id);
  });
});
