import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

const envTestPath = path.resolve(__dirname, '../../.env.test');
export const testUrl = fs
  .readFileSync(envTestPath, 'utf8')
  .match(/DATABASE_URL=(.+)/)?.[1] as string;

if (!testUrl) {
  throw new Error('.env.test not found or missing DATABASE_URL');
}

export const prodUrl = process.env.DATABASE_URL || null;

export const prisma = new PrismaClient({
  datasources: { db: { url: testUrl } },
});

export async function resetTestDb(): Promise<void> {
  await prisma.$executeRawUnsafe(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
}

export async function isSchemaApplied(): Promise<boolean> {
  try {
    const rows = await prisma.$queryRaw<Array<{ migration_name: string }>>`
      SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL
    `;
    const names = rows.map((r) => r.migration_name);
    return names.includes('0_init') && names.includes('20260731221214_sales_orders_v2');
  } catch {
    return false;
  }
}

export async function applyMigrations(): Promise<void> {
  const { execSync } = await import('child_process');
  execSync('npx prisma migrate deploy', {
    cwd: path.resolve(__dirname, '../../'),
    stdio: 'pipe',
    env: { ...process.env, DATABASE_URL: testUrl },
  });
}
