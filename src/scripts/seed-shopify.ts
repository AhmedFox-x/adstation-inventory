/**
 * seed-shopify.ts — Seed ALL Stylish Egypt products into AD Station Inventory
 *
 * Fetches products from Shopify API, maps categories, generates SKUs,
 * and inserts directly via Prisma (consistent with seed-prices.ts pattern).
 *
 * Usage:
 *   npx ts-node src/scripts/seed-shopify.ts            # live run
 *   npx ts-node src/scripts/seed-shopify.ts --dry-run  # preview only
 */

import { PrismaClient } from "@prisma/client";
import https from "https";

const prisma = new PrismaClient();

// ── Configuration ────────────────────────────────────────────────────────────
const SHOPIFY_BASE = "https://stylishegypt.net/collections/all/products.json";
const PAGE_SIZE = 250;
const STOCK_DEFAULT = 50;
const MIN_STOCK = 5;
const BRAND = "Stylish Egypt";
const DRY_RUN = process.argv.includes("--dry-run");
const API_DELAY_MS = 50; // delay between DB writes (avoid connection storms)

// ── Shopify Types ────────────────────────────────────────────────────────────
interface ShopifyVariant {
  id: number;
  title: string;
  price: string;
  available: boolean;
  sku: string | null;
  featured_image: { src: string } | null;
}

interface ShopifyProduct {
  id: number;
  title: string;
  product_type: string;
  handle: string;
  variants: ShopifyVariant[];
  images: { src: string; variant_ids: number[] }[];
}

interface ShopifyResponse {
  products: ShopifyProduct[];
}

// ── Category Mapping ─────────────────────────────────────────────────────────
// Key = lowercase Shopify product_type, Value = { category, skuPrefix }
const CATEGORY_MAP: Record<string, { category: string; skuPrefix: string }> = {
  "elegant pen":                { category: "Executive Pens",     skuPrefix: "EP" },
  "plastic pens":               { category: "Plastic Pens",       skuPrefix: "PP" },
  "pen set":                    { category: "Pen Sets",           skuPrefix: "PS" },
  "pen box":                    { category: "Pen Boxes",          skuPrefix: "PBX" },
  "thermal mug":                { category: "Thermal Mugs",       skuPrefix: "TM" },
  "mugs":                       { category: "Plastic Mugs",       skuPrefix: "PM" },
  "porcelain mug":              { category: "Porcelain Mugs",     skuPrefix: "CRM" },
  "notebook":                   { category: "Notebooks",          skuPrefix: "NB" },
  "notebook set":               { category: "Notebook Sets",      skuPrefix: "NBS" },
  "eco-friendly notebook":      { category: "Eco Notebooks",      skuPrefix: "ENB" },
  "keychains":                  { category: "Keychains",          skuPrefix: "KH" },
  "eco-friendly keychains":     { category: "Eco Keychains",      skuPrefix: "EKH" },
  "flash memory":               { category: "Flash Drives",       skuPrefix: "F" },
  "memo pads":                  { category: "Memo Pads",          skuPrefix: "MP" },
  "power bank":                 { category: "Power Banks",        skuPrefix: "PB" },
  "powerbank":                  { category: "Power Banks",        skuPrefix: "PB" },
  "cable":                      { category: "Cables",             skuPrefix: "CB" },
  "eco friendly cable":         { category: "Eco Cables",         skuPrefix: "ECB" },
  "connector":                  { category: "Connectors",         skuPrefix: "CN" },
  "speaker":                    { category: "Speakers",           skuPrefix: "SP" },
  "mouse":                      { category: "Mice",               skuPrefix: "MO" },
  "mobile holder":              { category: "Mobile Holders",     skuPrefix: "MH" },
  "car charger":                { category: "Car Chargers",       skuPrefix: "CC" },
  "card holder":                { category: "Card Holders",       skuPrefix: "CH" },
  "card holders":               { category: "Card Holders",       skuPrefix: "CH" },
  "eco-friendly card holder":   { category: "Card Holders",       skuPrefix: "CH" },
  "eco friendly card holder":   { category: "Card Holders",       skuPrefix: "CH" },
  "desk lamps":                 { category: "Desk Lamps",         skuPrefix: "DL" },
  "coasters":                   { category: "Coasters",           skuPrefix: "CST" },
  "eco-friendly coaster":       { category: "Coasters",           skuPrefix: "CST" },
  "wall clocks":                { category: "Wall Clocks",        skuPrefix: "WC" },
  "desk clocks":                { category: "Desk Clocks",        skuPrefix: "DC" },
  "crystal":                    { category: "Crystal Items",      skuPrefix: "CR" },
  "folders":                    { category: "Folders",            skuPrefix: "FLD" },
  "tool kits":                  { category: "Tool Kits",          skuPrefix: "TK" },
  "back packs":                 { category: "Backpacks",          skuPrefix: "BP" },
  "laptop bags":                { category: "Laptop Bags",        skuPrefix: "LB" },
  "cross bags":                 { category: "Cross Bags",         skuPrefix: "XB" },
  "tote bag":                   { category: "Tote Bags",          skuPrefix: "TB" },
  "waist bag":                  { category: "Waist Bags",         skuPrefix: "WB" },
  "hand bags":                  { category: "Hand Bags",          skuPrefix: "HDB" },
  "bag":                        { category: "Bags",               skuPrefix: "BG" },
  "wallets":                    { category: "Wallets",            skuPrefix: "WL" },
  "flasks":                     { category: "Flasks",             skuPrefix: "FLS" },
  "coffee machine":             { category: "Coffee Machines",    skuPrefix: "CFM" },
  "summer":                     { category: "Summer Items",       skuPrefix: "SUM" },
  "sunshade":                   { category: "Sunshades",          skuPrefix: "SNS" },
  "agenda":                     { category: "Agendas",            skuPrefix: "AGD" },
  "towels":                     { category: "Towels",             skuPrefix: "TOW" },
  "smart watches":              { category: "Smart Watches",      skuPrefix: "SW" },
  "polo shirt":                 { category: "Polo Shirts",        skuPrefix: "PSH" },
  "t-shirts":                   { category: "T-Shirts",           skuPrefix: "TS" },
  "tissue box":                 { category: "Tissue Boxes",       skuPrefix: "TBX" },
  "selfie stick":               { category: "Selfie Sticks",      skuPrefix: "SFS" },
  "general":                    { category: "General Gifts",      skuPrefix: "G" },
};

// Sub-classify "general" products by title prefix
function subClassifyGeneral(title: string): { category: string; skuPrefix: string } {
  if (/^chair/i.test(title))            return { category: "Chairs",         skuPrefix: "CHR" };
  if (/^sun\s?shade/i.test(title))      return { category: "Sunshades",      skuPrefix: "SNS" };
  if (/^travel\s?kit/i.test(title))     return { category: "Travel Kits",    skuPrefix: "TRV" };
  if (/racket/i.test(title))            return { category: "Sports Items",   skuPrefix: "SPT" };
  if (/magnifier/i.test(title))         return { category: "Magnifiers",     skuPrefix: "MAG" };
  if (/car\s?extra/i.test(title))       return { category: "Car Accessories", skuPrefix: "CAR" };
  if (/cup\s?holder/i.test(title))      return { category: "Gift Items",     skuPrefix: "G" };
  if (/^g\s?\d/i.test(title))           return { category: "Gift Items",     skuPrefix: "G" };
  if (/waterproof/i.test(title))        return { category: "Gift Items",     skuPrefix: "G" };
  if (/lantern/i.test(title))           return { category: "Gift Items",     skuPrefix: "G" };
  if (/lantern/i.test(title))           return { category: "Gift Items",     skuPrefix: "G" };
  if (/cooler/i.test(title))            return { category: "Gift Items",     skuPrefix: "G" };
  return { category: "General Gifts", skuPrefix: "G" };
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function normalizeTitle(title: string): string {
  return title
    .replace(/\./g, "")     // strip dots: N.B → NB
    .replace(/\s+/g, " ")   // collapse whitespace: EP  12 → EP 12
    .trim()
    .toLowerCase();
}

function extractNumber(title: string): string {
  const m = title.match(/(\d+)/);
  return m ? m[1] : "";
}

function generateSKU(
  title: string,
  skuPrefix: string,
  variantIndex: number,
  totalVariants: number,
): string {
  const num = extractNumber(title);

  // Build a clean suffix from the title beyond the number
  let suffix = title
    .replace(/^[A-Za-z.\s]*\d+/g, "") // remove prefix + number
    .replace(/[^A-Za-z]/g, "")         // keep only letters
    .trim()
    .substring(0, 5)                   // max 5 chars
    .toUpperCase();

  let base = skuPrefix + num + suffix;

  if (totalVariants > 1) {
    base += `-V${variantIndex}`;
  }

  return base;
}

function getImageUrl(variant: ShopifyVariant, product: ShopifyProduct): string | null {
  if (variant.featured_image?.src) return variant.featured_image.src;
  if (product.images?.length > 0) return product.images[0].src;
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Shopify Fetch ────────────────────────────────────────────────────────────
function fetchShopifyPage(page: number): Promise<ShopifyProduct[]> {
  return new Promise((resolve, reject) => {
    const url = `${SHOPIFY_BASE}?limit=${PAGE_SIZE}&page=${page}`;
    const doFetch = (fetchUrl: string, redirectCount = 0) => {
      if (redirectCount > 5) {
        reject(new Error("Too many redirects"));
        return;
      }
      https
        .get(fetchUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; ADStation-Seed/1.0)",
            "Accept": "application/json",
          },
        }, (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            doFetch(res.headers.location, redirectCount + 1);
            return;
          }
          let data = "";
          res.on("data", (chunk: Buffer) => (data += chunk.toString()));
          res.on("end", () => {
            try {
              const parsed: ShopifyResponse = JSON.parse(data);
              resolve(parsed.products || []);
            } catch (e) {
              console.error(`  Failed to parse response (status ${res.statusCode}). First 200 chars: ${data.substring(0, 200)}`);
              reject(e);
            }
          });
        })
        .on("error", reject);
    };
    doFetch(url);
  });
}

async function fetchAllShopifyProducts(): Promise<ShopifyProduct[]> {
  console.log("Fetching page 1 from Shopify...");
  const page1 = await fetchShopifyPage(1);
  console.log(`  Page 1: ${page1.length} products`);

  console.log("Fetching page 2 from Shopify...");
  const page2 = await fetchShopifyPage(2);
  console.log(`  Page 2: ${page2.length} products`);

  const all = [...page1, ...page2];
  console.log(`Total Shopify products fetched: ${all.length}\n`);
  return all;
}

// ── Main Seeding Logic ───────────────────────────────────────────────────────
async function main() {
  console.log("=".repeat(70));
  console.log("  AD Station — Shopify Product Seed Script");
  console.log(`  Mode: ${DRY_RUN ? "DRY RUN (no writes)" : "LIVE"}`);
  console.log("=".repeat(70));
  console.log("");

  // 1. Fetch Shopify data
  const shopifyProducts = await fetchAllShopifyProducts();

  // 2. Load existing DB products for dedup
  console.log("Loading existing DB products for dedup...");
  const existingProducts = await prisma.product.findMany({
    where: { deletedAt: null },
    select: { id: true, name: true, sku: true },
  });
  const existingTitles = new Set(existingProducts.map((p) => normalizeTitle(p.name)));
  const existingSkus = new Set(existingProducts.filter((p) => p.sku).map((p) => p.sku!));
  console.log(`  Found ${existingTitles.size} existing DB products\n`);

  // 3. Group Shopify products by (normalized) product_type
  const grouped = new Map<string, ShopifyProduct[]>();
  for (const p of shopifyProducts) {
    const type = (p.product_type || "").trim().toLowerCase();
    if (!grouped.has(type)) grouped.set(type, []);
    grouped.get(type)!.push(p);
  }

  console.log(`Found ${grouped.size} product types:`);
  for (const [type, products] of [...grouped.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const totalVariants = products.reduce((sum, p) => sum + p.variants.length, 0);
    console.log(`  ${type || "(empty)"}: ${products.length} products, ${totalVariants} variants`);
  }
  console.log("");

  // 4. Process each category
  let totalCreated = 0;
  let totalSkipped = 0;
  let totalErrors = 0;
  let totalVariantsCreated = 0;
  const categoryOrder = [...grouped.keys()].sort();

  const report: Record<string, { created: number; skipped: number; errors: number; variants: number }> = {};

  for (const type of categoryOrder) {
    const products = grouped.get(type)!;
    const mapping = CATEGORY_MAP[type];

    let catInfo: { category: string; skuPrefix: string };
    if (type === "general") {
      catInfo = { category: "General Gifts", skuPrefix: "G" };
    } else if (!mapping) {
      catInfo = { category: "Miscellaneous", skuPrefix: "MISC" };
    } else {
      catInfo = mapping;
    }

    console.log(`\n--- ${catInfo.category} (${type || "(empty)"}) — ${products.length} products ---`);

    let catCreated = 0;
    let catSkipped = 0;
    let catErrors = 0;
    let catVariants = 0;

    for (const shopifyProduct of products) {
      const normTitle = normalizeTitle(shopifyProduct.title);

      // Dedup: check DB
      if (existingTitles.has(normTitle)) {
        catSkipped++;
        totalSkipped++;
        continue;
      }

      // Determine per-product category (sub-classify general)
      let finalCategory = catInfo.category;
      let finalSkuPrefix = catInfo.skuPrefix;
      if (type === "general") {
        const sub = subClassifyGeneral(shopifyProduct.title);
        finalCategory = sub.category;
        finalSkuPrefix = sub.skuPrefix;
      }

      const variants = shopifyProduct.variants;
      let variantsCreated = 0;

      for (let vi = 0; vi < variants.length; vi++) {
        const variant = variants[vi];
        const variantIndex = vi + 1;

        // Generate SKU
        let sku = generateSKU(
          shopifyProduct.title,
          finalSkuPrefix,
          variantIndex,
          variants.length,
        );

        // Handle SKU collision
        let skuAttempt = 0;
        while (existingSkus.has(sku) || skuAttempt > 0) {
          skuAttempt++;
          sku = generateSKU(shopifyProduct.title, finalSkuPrefix, variantIndex, variants.length) + `-D${skuAttempt}`;
        }

        const productName = shopifyProduct.title.trim();
        const variantName = variants.length > 1 ? variant.title.trim() : null;
        const imageUrl = getImageUrl(variant, shopifyProduct);
        const price = parseFloat(variant.price) || 0;
        const stock = variant.available ? STOCK_DEFAULT : 0;

        if (DRY_RUN) {
          variantsCreated++;
        } else {
          try {
            await prisma.product.create({
              data: {
                name: productName,
                variant: variantName,
                stock,
                minStock: MIN_STOCK,
                sku,
                category: finalCategory,
                brand: BRAND,
                price,
                imageUrl,
              },
            });
            existingSkus.add(sku);
            variantsCreated++;
            catVariants++;
            totalVariantsCreated++;
          } catch (err: any) {
            if (err?.code === "P2002") {
              console.log(`  WARN: SKU collision ${sku} — "${shopifyProduct.title}" v${variant.title}`);
              catErrors++;
              totalErrors++;
              continue;
            }
            throw err;
          }
        }

        if (API_DELAY_MS > 0 && !DRY_RUN) {
          await sleep(API_DELAY_MS);
        }
      }

      if (variantsCreated > 0) {
        existingTitles.add(normTitle); // block future dupes in this run
        catCreated++;
        totalCreated++;
      }

      // Progress log every 25 products
      if (catCreated % 25 === 0 && catCreated > 0) {
        console.log(`  ... ${catCreated}/${products.length} products created`);
      }
    }

    report[catInfo.category] = { created: catCreated, skipped: catSkipped, errors: catErrors, variants: catVariants };
    console.log(`  => +${catCreated} products (${catVariants} variants), ${catSkipped} skipped, ${catErrors} errors`);
  }

  // 5. Assign barcodes (only in live mode)
  let barcodeCount = 0;
  if (!DRY_RUN && totalCreated > 0) {
    console.log("\n--- Assigning barcodes to new products ---");
    const { seedBarcodes } = await import("../utils/barcode");
    barcodeCount = await seedBarcodes();
    console.log(`  Assigned barcodes to ${barcodeCount} products`);
  }

  // 6. Final report
  console.log("\n" + "=".repeat(70));
  console.log("  SEED COMPLETE");
  console.log("=".repeat(70));
  console.log(`  Shopify products fetched:  ${shopifyProducts.length}`);
  console.log(`  Products created:          ${totalCreated}`);
  console.log(`  Variants created:          ${totalVariantsCreated}`);
  console.log(`  Products skipped (dup):    ${totalSkipped}`);
  console.log(`  Errors:                    ${totalErrors}`);
  console.log(`  Barcodes assigned:         ${barcodeCount}`);
  console.log(`  New total in DB:           ${existingTitles.size + totalCreated}`);
  console.log("=".repeat(70));

  // 7. Category breakdown
  console.log("\n  CATEGORY BREAKDOWN:");
  console.log("  " + "-".repeat(65));
  console.log(`  ${"Category".padEnd(25)} | ${"Created".padStart(8)} | ${"Variants".padStart(9)} | ${"Skipped".padStart(8)} | ${"Errors".padStart(6)}`);
  console.log("  " + "-".repeat(65));
  const sortedReport = Object.entries(report).sort((a, b) => b[1].created - a[1].created);
  for (const [cat, stats] of sortedReport) {
    if (stats.created > 0 || stats.skipped > 0) {
      console.log(`  ${cat.padEnd(25)} | ${String(stats.created).padStart(8)} | ${String(stats.variants).padStart(9)} | ${String(stats.skipped).padStart(8)} | ${String(stats.errors).padStart(6)}`);
    }
  }
  console.log("  " + "-".repeat(65));
}

main()
  .catch((e) => {
    console.error("FATAL ERROR:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
