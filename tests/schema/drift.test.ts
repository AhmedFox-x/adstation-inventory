import { execSync } from 'child_process';
import * as path from 'path';
import { testUrl } from './helpers';

const root = path.resolve(__dirname, '../../');

function run(cmd: string): string {
  return execSync(cmd, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: testUrl },
  });
}

describe('Drift Test', () => {
  test('prisma migrate status: لسه up to date (مفيش drift) — على TEST DB', () => {
    const out = run('npx prisma migrate status');
    expect(out).toMatch(/up to date/i);
  });

  test('prisma validate: schema سليم', () => {
    const out = run('npx prisma validate');
    expect(out).toMatch(/valid/i);
  });

  test('migrate diff من DB الحالية للـ schema: فاضي', () => {
    const out = run('npx prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --script');
    expect(out).toMatch(/empty migration/i);
  });

  test('الاختبارات بتشتغل على TEST DB مش PRODUCTION', () => {
    const testDbName = testUrl.split('/').pop()!;
    expect(testDbName).toContain('test');

    const prodUrl = process.env.DATABASE_URL;
    if (prodUrl) {
      const prodDbName = prodUrl.split('/').pop()!;
      expect(testDbName).not.toBe(prodDbName);
    }
  });
});
