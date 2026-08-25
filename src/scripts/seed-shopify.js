/**
 * seed-shopify.ts — Seed ALL Stylish Egypt products into AD Station Inventory
 *
 * Fetches products from Shopify API, maps categories, generates SKUs,
 * and creates via HTTP REST API (since Railway DB is not accessible locally).
 *
 * Usage:
 *   node seed-shopify.js            # live run
 *   node seed-shopify.js --dry-run  # preview only
 */

const https = require("https");
const http = require("http");

// ── Configuration ────────────────────────────────────────────────────────────
const SHOPIFY_BASE = "https://stylishegypt.net/collections/all/products.json";
const API_BASE = "https://inventory-backend-production-7df2.up.railway.app/api/inventory";
const PAGE_SIZE = 250;
const STOCK_DEFAULT = 50;
const MIN_STOCK = 5;
const BRAND = "Stylish Egypt";
const DRY_RUN = process.argv.includes("--dry-run");
const API_DELAY_MS = 5000; // 5s between DB writes — stays under Railway's ~200 req/15min limit
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 60000; // 60s base wait on 429
const EMAIL = "admin@adstation.com";
const PASSWORD = "admin123";

// ── Category Mapping ─────────────────────────────────────────────────────────
const CATEGORY_MAP = {
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
function subClassifyGeneral(title) {
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
  if (/cooler/i.test(title))            return { category: "Gift Items",     skuPrefix: "G" };
  return { category: "General Gifts", skuPrefix: "G" };
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function normalizeTitle(title) {
  return title
    .replace(/\./g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function extractNumber(title) {
  const m = title.match(/(\d+)/);
  return m ? m[1] : "";
}

function generateSKU(title, skuPrefix, variantIndex, totalVariants) {
  const num = extractNumber(title);
  let suffix = title
    .replace(/^[A-Za-z.\s]*\d+/g, "")
    .replace(/[^A-Za-z]/g, "")
    .trim()
    .substring(0, 5)
    .toUpperCase();
  let base = skuPrefix + num + suffix;
  if (totalVariants > 1) {
    base += `-V${variantIndex}`;
  }
  return base;
}

function getImageUrl(variant, product) {
  if (variant.featured_image && variant.featured_image.src) return variant.featured_image.src;
  if (product.images && product.images.length > 0) return product.images[0].src;
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── HTTP Helpers ─────────────────────────────────────────────────────────────
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    mod.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; ADStation-Seed/1.0)",
        "Accept": "application/json",
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        httpGet(res.headers.location).then(resolve).catch(reject);
        return;
      }
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          console.error(`  Failed to parse response (status ${res.statusCode}). First 200 chars: ${data.substring(0, 200)}`);
          reject(e);
        }
      });
    }).on("error", reject);
  });
}

function httpPostRaw(url, body, token) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const urlObj = new URL(url);
    const headers = {
      "Content-Type": "application/json",
    };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const req = mod.request({
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === "https:" ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: "POST",
      headers,
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, data: data });
        }
      });
    });
    req.on("error", reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function httpPost(url, body, token) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await httpPostRaw(url, body, token);
    if (res.status !== 429) return res;

    // retryAfter is in MINUTES from Railway, convert to ms
    const retryMinutes = (res.data && res.data.retryAfter) || 15;
    const waitMs = retryMinutes * 60 * 1000;
    const waitMin = Math.ceil(waitMs / 60000);
    console.log(`    ⏳ Rate limited (429). Waiting ${waitMin}m before retry (attempt ${attempt + 1}/${MAX_RETRIES})...`);
    await sleep(waitMs);
  }
  // Exhausted retries — return last 429
  return httpPostRaw(url, body, token);
}

function httpGetAuth(url, token) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const urlObj = new URL(url);
    mod.get(url, {
      headers: {
        "Authorization": `Bearer ${token}`,
        "Accept": "application/json",
      },
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, data: data });
        }
      });
    }).on("error", reject);
  });
}

// ── Shopify Fetch ────────────────────────────────────────────────────────────
async function fetchShopifyPage(page) {
  const url = `${SHOPIFY_BASE}?limit=${PAGE_SIZE}&page=${page}`;
  const parsed = await httpGet(url);
  return parsed.products || [];
}

async function fetchAllShopifyProducts() {
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
  console.log("  AD Station — Shopify Product Seed Script (HTTP API)");
  console.log(`  Mode: ${DRY_RUN ? "DRY RUN (no writes)" : "LIVE"}`);
  console.log("=".repeat(70));
  console.log("");

  // 1. Fetch Shopify data
  const shopifyProducts = await fetchAllShopifyProducts();

  // 2. Authenticate (always, even dry-run, for dedup)
  console.log("Authenticating with backend...");
  const authRes = await httpPost(`${API_BASE}/auth/login`, { email: EMAIL, password: PASSWORD });
  if (authRes.status !== 200 || !authRes.data.token) {
    console.error("  Auth failed:", JSON.stringify(authRes.data));
    process.exit(1);
  }
  const token = authRes.data.token;
  console.log("  Authenticated successfully\n");

  // 3. Load existing DB products for dedup (smart matching)
  console.log("Loading existing DB products for dedup...");
  const existingTitles = new Set();
  const existingSkus = new Set();
  const existingCoreKeys = new Set(); // e.g. "ep12", "kh19", "mug11", "nb10"
  let page = 1;
  while (true) {
    const res = await httpGetAuth(`${API_BASE}/products?limit=200&page=${page}`, token);
    if (res.status !== 200) break;
    const prods = res.data.products || [];
    for (const p of prods) {
      existingTitles.add(normalizeTitle(p.name));
      if (p.sku) existingSkus.add(p.sku);
      // Extract core key: prefix + number from name (e.g. "EP 12 Elegant Pen" → "ep12")
      const coreMatch = (p.name || "").match(/^([A-Za-z.\s]*\d+)/);
      if (coreMatch) {
        existingCoreKeys.add(normalizeTitle(coreMatch[1]).replace(/\s+/g, ""));
      }
    }
    if (page >= (res.data.pages || 1)) break;
    page++;
  }
  console.log(`  Found ${existingTitles.size} unique product names (${existingCoreKeys.size} core keys) in DB\n`);

  // 4. Group Shopify products by (normalized) product_type
  const grouped = {};
  for (const p of shopifyProducts) {
    const type = (p.product_type || "").trim().toLowerCase();
    if (!grouped[type]) grouped[type] = [];
    grouped[type].push(p);
  }

  const typeKeys = Object.keys(grouped).sort();
  console.log(`Found ${typeKeys.length} product types:`);
  for (const type of typeKeys) {
    const products = grouped[type];
    const totalVariants = products.reduce((sum, p) => sum + p.variants.length, 0);
    console.log(`  ${type || "(empty)"}: ${products.length} products, ${totalVariants} variants`);
  }
  console.log("");

  // 5. Process each category
  let totalCreated = 0;
  let totalSkipped = 0;
  let totalErrors = 0;
  let totalVariantsCreated = 0;
  const report = {};

  for (const type of typeKeys) {
    const products = grouped[type];
    const mapping = CATEGORY_MAP[type];

    let catInfo;
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

      // Dedup: check DB (exact title match)
      if (existingTitles.has(normTitle)) {
        catSkipped++;
        totalSkipped++;
        continue;
      }

      // Dedup: check DB (core key match - prefix+number)
      // e.g. Shopify "EP  12" normalizes core to "ep12", DB has "EP 12 Elegant Pen" with core "ep12"
      const shopifyCoreMatch = shopifyProduct.title.match(/^([A-Za-z.\s]*\d+)/);
      if (shopifyCoreMatch) {
        const shopifyCoreKey = normalizeTitle(shopifyCoreMatch[1]).replace(/\s+/g, "");
        if (existingCoreKeys.has(shopifyCoreKey)) {
          catSkipped++;
          totalSkipped++;
          continue;
        }
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
        while (existingSkus.has(sku)) {
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
          catVariants++;
          totalVariantsCreated++;
        } else {
          try {
            const body = {
              name: productName,
              variant: variantName,
              stock,
              minStock: MIN_STOCK,
              sku,
              category: finalCategory,
              price,
              imageUrl,
            };
            const res = await httpPost(`${API_BASE}/products`, body, token);
            if (res.status === 201) {
              existingSkus.add(sku);
              variantsCreated++;
              catVariants++;
              totalVariantsCreated++;
            } else if (res.status === 409) {
              // SKU collision, skip
              continue;
            } else {
              console.log(`  ERR: ${res.status} for "${shopifyProduct.title}" v${variant.title}: ${JSON.stringify(res.data)}`);
              catErrors++;
              totalErrors++;
              continue;
            }
          } catch (err) {
            console.log(`  ERR: Network error for "${shopifyProduct.title}": ${err.message}`);
            catErrors++;
            totalErrors++;
            continue;
          }
        }

        if (API_DELAY_MS > 0 && !DRY_RUN) {
          await sleep(API_DELAY_MS);
        }
      }

      if (variantsCreated > 0) {
        existingTitles.add(normTitle);
        // Also add core key to prevent intra-run dupes
        const coreMatch2 = shopifyProduct.title.match(/^([A-Za-z.\s]*\d+)/);
        if (coreMatch2) {
          existingCoreKeys.add(normalizeTitle(coreMatch2[1]).replace(/\s+/g, ""));
        }
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

  // 6. Assign barcodes (only in live mode)
  let barcodeCount = 0;
  if (!DRY_RUN && totalCreated > 0) {
    console.log("\n--- Assigning barcodes to new products ---");
    const res = await httpPost(`${API_BASE}/products/seed-barcodes`, {}, token);
    if (res.status === 200) {
      barcodeCount = res.data.count || 0;
      console.log(`  Assigned barcodes to ${barcodeCount} products`);
    } else {
      console.log(`  Barcode seed failed: ${JSON.stringify(res.data)}`);
    }
  }

  // 7. Final report
  console.log("\n" + "=".repeat(70));
  console.log("  SEED COMPLETE");
  console.log("=".repeat(70));
  console.log(`  Shopify products fetched:  ${shopifyProducts.length}`);
  console.log(`  Products created:          ${totalCreated}`);
  console.log(`  Variants created:          ${totalVariantsCreated}`);
  console.log(`  Products skipped (dup):    ${totalSkipped}`);
  console.log(`  Errors:                    ${totalErrors}`);
  console.log(`  Barcodes assigned:         ${barcodeCount}`);
  console.log("=".repeat(70));

  // 8. Category breakdown
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
  });
