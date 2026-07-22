import { PrismaClient } from "@prisma/client";
import fs from "fs";
import path from "path";

const prisma = new PrismaClient();

interface ImportProduct {
  name: string;
  image: string;
}

const DATA_DIR = process.env.IMPORT_DIR || path.resolve(__dirname, "../../import-data");
const PRODUCTS_JSON = path.join(DATA_DIR, "products.json");
const IMAGES_DIR = path.join(DATA_DIR, "images");
const UPLOADS_DIR = path.resolve(__dirname, "../public/uploads/products");

async function main() {
  if (!fs.existsSync(PRODUCTS_JSON)) {
    console.log("ℹ️  No import-data/products.json found — skipping import.");
    return;
  }

  const raw = fs.readFileSync(PRODUCTS_JSON, "utf-8");
  const products: ImportProduct[] = JSON.parse(raw);
  console.log(`📦 Found ${products.length} products in import data`);

  if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  }

  // Always sync images (deterministic filenames) — Railway ephemeral fs
  let imagesCopied = 0;
  for (const p of products) {
    if (!p.image) continue;
    const src = path.join(IMAGES_DIR, p.image);
    const destName = p.image;
    const dest = path.join(UPLOADS_DIR, destName);
    if (fs.existsSync(src) && !fs.existsSync(dest)) {
      fs.copyFileSync(src, dest);
      imagesCopied++;
    }
  }
  console.log(`🖼️  Synced ${imagesCopied} images to uploads/`);

  const existing = await prisma.product.count();
  if (existing > 0) {
    console.log(`ℹ️  Database already has ${existing} products — skipping data import.`);
    return;
  }

  let created = 0;
  let skipped = 0;

  for (const p of products) {
    if (!p.name || !p.name.trim()) {
      skipped++;
      continue;
    }

    const imageUrl = p.image ? `/uploads/products/${p.image}` : null;

    await prisma.product.create({
      data: {
        name: p.name.trim(),
        stock: 0,
        minStock: 5,
        imageUrl,
      },
    });
    created++;

    if (created % 100 === 0) {
      console.log(`  ✅ ${created}/${products.length} imported...`);
    }
  }

  const total = await prisma.product.count();
  console.log(`\n✅ Import complete: ${created} products created, ${skipped} skipped`);
  console.log(`📊 Total products in database: ${total}`);
}

main()
  .catch((e) => {
    console.error("❌ Import failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
