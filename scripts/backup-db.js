const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');

const prisma = new PrismaClient();

const MODELS = [
  'roleConfig', 'user', 'product', 'reservation',
  'withdrawalPermit', 'withdrawalItem', 'supplyPermit', 'supplyItem',
  'inventoryLog', 'stocktakeSession', 'stocktakeItem',
  'supplier', 'client', 'purchaseOrder', 'purchaseOrderItem', 'purchaseOrderStatusHistory',
  'salesOrder', 'salesOrderItem', 'salesOrderStatusHistory',
];

async function main() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join('C:', 'AdStation System', 'Backups', 'db');
  fs.mkdirSync(dir, { recursive: true });

  const manifest = { timestamp: new Date().toISOString(), tables: [] };

  for (const model of MODELS) {
    try {
      const rows = await prisma[model].findMany();
      const file = path.join(dir, `${ts}-${model}.json`);
      fs.writeFileSync(file, JSON.stringify(rows, null, 2), 'utf-8');
      manifest.tables.push({ table: model, rows: rows.length, file: path.basename(file) });
      console.log(`✅ ${model}: ${rows.length} rows`);
    } catch (e) {
      console.log(`⚠️ ${model}: ${e.message.slice(0, 80)}`);
    }
  }

  const manifestFile = path.join(dir, `${ts}-manifest.json`);
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), 'utf-8');
  console.log(`\n📦 DB Backup complete → ${dir}`);
  console.log(`📋 Manifest: ${manifestFile}`);
}

main().catch(e => { console.error('❌ Backup failed:', e.message); process.exit(1); });
