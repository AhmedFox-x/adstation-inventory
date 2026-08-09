import { PrismaClient } from '@prisma/client';
import { DEFAULT_ROLES, ALL_PERMISSIONS } from './permissions';

export interface UpsertRolesResult {
  created: string[];
  updated: string[];
}

/**
 * ينشئ الأدوار المفقودة ويحدّث الموجودة من DEFAULT_ROLES.
 * الدمج صريح: كل دور موجود يأخذ أحدث تعريف له من الكود (owner = ALL_PERMISSIONS).
 * الحقل isSystem=true مضمون للأدوار المدمجة — أي دور isSystem=false (Custom) لا يُلمس إطلاقًا.
 * Applies على نفس الـ PrismaClient المعطى — مناسب للاستدعاء من seed.ts ومن API.
 */
export async function upsertDefaultRoles(prisma: PrismaClient): Promise<UpsertRolesResult> {
  const result: UpsertRolesResult = { created: [], updated: [] };

  for (const [name, config] of Object.entries(DEFAULT_ROLES)) {
    const existing = await prisma.roleConfig.findUnique({ where: { name } });

    if (!existing) {
      await prisma.roleConfig.create({
        data: {
          name,
          displayName: config.displayName,
          description: config.description,
          permissions: JSON.stringify(config.permissions),
          isSystem: true,
        },
      });
      result.created.push(name);
      continue;
    }

    if (!existing.isSystem) {
      continue;
    }

    const current: string[] = JSON.parse(existing.permissions);
    const expected: string[] =
      name === 'owner' ? ALL_PERMISSIONS : [...new Set(config.permissions)];

    const needsUpdate =
      current.length !== expected.length ||
      expected.some((p) => !current.includes(p));

    if (needsUpdate) {
      await prisma.roleConfig.update({
        where: { id: existing.id },
        data: {
          displayName: config.displayName,
          description: config.description,
          permissions: JSON.stringify(expected),
          isSystem: true,
        },
      });
      result.updated.push(name);
    }
  }

  return result;
}
