import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const products = [
  { name: "نوت بوك A5", variant: "أسود", stock: 150, minStock: 20, category: "نوت بوكس" },
  { name: "نوت بوك A5", variant: "أبيض", stock: 80, minStock: 20, category: "نوت بوكس" },
  { name: "قلم دعائي", variant: "أزرق", stock: 500, minStock: 50, category: "أقلام" },
  { name: "قلم دعائي", variant: "أسود", stock: 450, minStock: 50, category: "أقلام" },
  { name: "كوب فينيل", variant: "أبيض", stock: 200, minStock: 30, category: "كبايات" },
  { name: "كوب زجاجي", variant: "شفاف", stock: 120, minStock: 20, category: "كبايات" },
  { name: "فلاشة USB 16GB", variant: null, stock: 8, minStock: 15, category: "فلاشات" },
  { name: "تيشيرت قطن", variant: "أسود — L", stock: 60, minStock: 10, category: "تيشيرتات" },
  { name: "تيشيرت قطن", variant: "أبيض — M", stock: 45, minStock: 10, category: "تيشيرتات" },
  { name: "شنطة هدايا", variant: "كبير", stock: 0, minStock: 20, category: "شنط" },
  { name: "بروشور A4", variant: null, stock: 1000, minStock: 100, category: "مواد إعلانية" },
  { name: "بانر فينيل", variant: "2×1 متر", stock: 3, minStock: 5, category: "مواد إعلانية" },
];

async function main() {
  const existing = await prisma.product.count();
  if (existing > 0) {
    console.log(`ℹ️  Database already has ${existing} products — skipping seed.`);
    return;
  }

  console.log("Seeding inventory products...");

  for (const p of products) {
    await prisma.product.create({
      data: {
        name: p.name,
        variant: p.variant,
        stock: p.stock,
        minStock: p.minStock,
        category: p.category,
      },
    });
  }

  const count = await prisma.product.count();
  console.log(`✅ Seeded ${count} products`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
