import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function main() {
  console.log("Connecting to database...");
  const rows = await prisma.$queryRaw`SELECT "id", "name", "type" FROM "Warehouse" WHERE "deletedAt" IS NULL` as any[];
  console.log("Current warehouse names:", JSON.stringify(rows, null, 2));

  const mainResult = await prisma.$executeRaw`UPDATE "Warehouse" SET "name" = ${'المخزن الأساسي'} WHERE "type" = 'MAIN' AND "deletedAt" IS NULL`;
  console.log(`MAIN update: ${mainResult} row(s)`);

  const quarResult = await prisma.$executeRaw`UPDATE "Warehouse" SET "name" = ${'مخزن لطفي'} WHERE "type" = 'QUARANTINE' AND "deletedAt" IS NULL`;
  console.log(`QUARANTINE update: ${quarResult} row(s)`);

  const after = await prisma.$queryRaw`SELECT "id", "name", "type" FROM "Warehouse" WHERE "deletedAt" IS NULL` as any[];
  console.log("After fix:", JSON.stringify(after, null, 2));

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
