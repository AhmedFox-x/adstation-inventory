/**
 * companyService.ts — Company name cache backed by SystemSettings
 *
 * Reads/writes "company_name" from SystemSettings table.
 * In-memory cache with 5-minute TTL to avoid DB hits on every request.
 */

import { PrismaClient } from "@prisma/client";

const CACHE_KEY = "company_name";
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let cacheValue: string | null = null;
let cacheExpiry: number = 0;
const DEFAULT_NAME = "AD Station";

export async function getCompanyName(prisma: PrismaClient): Promise<string> {
  const now = Date.now();
  if (cacheValue !== null && now < cacheExpiry) {
    return cacheValue;
  }

  try {
    const setting = await prisma.systemSettings.findUnique({
      where: { key: CACHE_KEY },
    });
    cacheValue = setting?.value || DEFAULT_NAME;
    cacheExpiry = now + CACHE_TTL_MS;
  } catch {
    cacheValue = DEFAULT_NAME;
    cacheExpiry = now + CACHE_TTL_MS;
  }

  return cacheValue;
}

export async function setCompanyName(prisma: PrismaClient, name: string): Promise<void> {
  const trimmed = name.trim() || DEFAULT_NAME;
  await prisma.systemSettings.upsert({
    where: { key: CACHE_KEY },
    create: { key: CACHE_KEY, value: trimmed },
    update: { value: trimmed },
  });
  cacheValue = trimmed;
  cacheExpiry = Date.now() + CACHE_TTL_MS;
}

/**
 * Synchronous getter — returns cached value or default.
 * Only use in contexts where DB access is not possible (e.g., print templates).
 * Call getCompanyName() at startup to warm the cache.
 */
export function getCompanyNameSync(): string {
  return cacheValue || DEFAULT_NAME;
}

/** Invalidate the in-memory cache (e.g., after update) */
export function invalidateCompanyCache(): void {
  cacheValue = null;
  cacheExpiry = 0;
}
