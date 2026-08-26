/**
 * seed-inventory-logs.js — Create inventory log entries for ALL seeded products
 *
 * Simulates manual product addition: for each product, creates a log entry
 * as if the admin added the product one by one (manual_adjust, oldStock=0 → newStock=X).
 *
 * Usage:
 *   node seed-inventory-logs.js           # live run
 *   node seed-inventory-logs.js --dry-run # preview only
 */

const https = require("https");

const API_BASE = "https://inventory-backend-production-7df2.up.railway.app/api/inventory";
const BATCH_SIZE = 200; // max entries per batch call
const API_DELAY_MS = 500;
const DRY_RUN = process.argv.includes("--dry-run");
const EMAIL = "admin@adstation.com";
const PASSWORD = "admin123";

function httpGet(url, token) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const headers = { "Accept": "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    https.get({
      hostname: urlObj.hostname, port: 443,
      path: urlObj.pathname + urlObj.search, headers,
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch { reject(new Error(data)); } });
    }).on("error", reject);
  });
}

function httpPost(url, body, token) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const headers = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const req = https.request({
      hostname: urlObj.hostname, port: 443,
      path: urlObj.pathname + urlObj.search, method: "POST", headers,
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on("error", reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Stagger timestamps so logs look like they were created over time
function randomRecentDate() {
  // Random time in last 24 hours
  const now = Date.now();
  const offset = Math.floor(Math.random() * 24 * 60 * 60 * 1000);
  return new Date(now - offset).toISOString();
}

async function main() {
  console.log("=".repeat(70));
  console.log("  AD Station — Inventory Log Seed Script");
  console.log(`  Mode: ${DRY_RUN ? "DRY RUN (no writes)" : "LIVE"}`);
  console.log("=".repeat(70));

  // 1. Authenticate
  console.log("\nAuthenticating...");
  const auth = await httpPost(`${API_BASE}/auth/login`, { email: EMAIL, password: PASSWORD });
  if (auth.status !== 200) {
    console.error("Auth failed:", auth.data);
    process.exit(1);
  }
  const token = auth.data.token;
  const userId = auth.data.user.id;
  const userName = auth.data.user.name;
  const userRole = auth.data.user.role;
  console.log(`  Authenticated as ${userName} (${userRole})`);

  // 2. Fetch ALL products
  console.log("\nFetching all products...");
  let allProducts = [];
  let page = 1;
  let totalPages = 1;
  while (page <= totalPages) {
    const resp = await httpGet(`${API_BASE}/products?limit=250&page=${page}`, token);
    if (resp.products && resp.products.length > 0) {
      allProducts.push(...resp.products);
      totalPages = resp.pages || 1;
      console.log(`  Page ${page}/${totalPages}: ${resp.products.length} products (total so far: ${allProducts.length})`);
    } else {
      console.log(`  Page ${page}: no products`);
      break;
    }
    page++;
    await sleep(500);
  }
  console.log(`  Total products fetched: ${allProducts.length}`);

  // 3. Filter: only products with stock > 0 (newly added ones)
  const productsWithStock = allProducts.filter(p => p.stock > 0);
  console.log(`  Products with stock > 0: ${productsWithStock.length}`);

  // 4. Check existing logs to avoid duplicates
  console.log("\nChecking existing log entries...");
  const logResp = await httpGet(`${API_BASE}/log?limit=1`, token);
  const existingLogCount = logResp.total || 0;
  console.log(`  Existing log entries: ${existingLogCount}`);

  if (existingLogCount > 0 && !DRY_RUN) {
    console.log("\n  ⚠️  Logs already exist. Skipping to avoid duplicates.");
    console.log("  To force re-creation, clear logs first or use a different approach.");
    // Still proceed — user may want to add more
  }

  // 5. Build log entries
  console.log("\nBuilding log entries...");
  const entries = productsWithStock.map(p => ({
    type: "manual_adjust",
    productId: p.id,
    oldStock: 0,
    newStock: p.stock,
    change: p.stock,
    notes: `إضافة منتج جديد يدوياً — ${p.name}`,
    entityType: "product",
    entityId: p.id,
    userId,
    userName,
    userRole,
    beforeData: { stock: 0 },
    afterData: { stock: p.stock, name: p.name, sku: p.sku, category: p.category, price: p.price },
  }));

  console.log(`  Total entries to create: ${entries.length}`);

  if (DRY_RUN) {
    console.log("\n  DRY RUN — Sample entries:");
    entries.slice(0, 5).forEach((e, i) => {
      console.log(`    ${i + 1}. ${e.notes} | stock: ${e.oldStock}→${e.newStock} (change: +${e.change})`);
    });
    if (entries.length > 5) console.log(`    ... and ${entries.length - 5} more`);
    console.log("\n  DRY RUN COMPLETE");
    return;
  }

  // 6. Send in batches
  console.log("\nSending log entries in batches...");
  let totalCreated = 0;
  let totalErrors = 0;

  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(entries.length / BATCH_SIZE);
    process.stdout.write(`  Batch ${batchNum}/${totalBatches} (${batch.length} entries)... `);

    const res = await httpPost(`${API_BASE}/log/batch`, { entries: batch }, token);
    if (res.status === 201) {
      totalCreated += res.data.created;
      console.log(`OK (+${res.data.created})`);
    } else {
      console.log(`FAIL (${res.status}): ${JSON.stringify(res.data).substring(0, 200)}`);
      totalErrors += batch.length;
    }

    await sleep(API_DELAY_MS);
  }

  console.log("\n" + "=".repeat(70));
  console.log("  LOG SEED COMPLETE");
  console.log("=".repeat(70));
  console.log(`  Total entries created: ${totalCreated}`);
  console.log(`  Errors: ${totalErrors}`);
  console.log("=".repeat(70));
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
