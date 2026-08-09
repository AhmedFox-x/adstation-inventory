import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

interface PriceRange {
  pattern: RegExp;
  min: number;
  max: number;
}

const PRICE_RULES: PriceRange[] = [
  // Power banks (high value electronics)
  { pattern: /^power bank/i, min: 250, max: 650 },
  { pattern: /^bank \d/i, min: 250, max: 650 },
  { pattern: /^PB /i, min: 250, max: 550 },

  // Flash + power combos
  { pattern: /^FL \d/i, min: 200, max: 550 },

  // Speakers
  { pattern: /^speaker/i, min: 200, max: 600 },

  // Smart Watch
  { pattern: /^smart watch/i, min: 350, max: 650 },

  // Digital clocks
  { pattern: /^DC \d/i, min: 180, max: 450 },

  // Lamps USB
  { pattern: /^lamp usb/i, min: 150, max: 400 },

  // Car chargers
  { pattern: /^car charger/i, min: 100, max: 350 },

  // Mouse (computer)
  { pattern: /^mouse/i, min: 80, max: 280 },

  // Cables
  { pattern: /^cable/i, min: 35, max: 130 },

  // Connectors
  { pattern: /^conne[ct]or/i, min: 80, max: 250 },

  // Chargers (CH = charger key holder type)
  { pattern: /^CH \d/i, min: 150, max: 420 },

  // Key holders (KH)
  { pattern: /^KH \d/i, min: 80, max: 260 },

  // Bags - large
  { pattern: /^bag \d/i, min: 180, max: 500 },
  { pattern: /^bagg/i, min: 180, max: 500 },

  // Felt bags
  { pattern: /^felt bag/i, min: 100, max: 200 },

  // Cooler bags
  { pattern: /^cooler bag/i, min: 130, max: 260 },

  // Tote bag
  { pattern: /^tote bag/i, min: 120, max: 250 },

  // Chairs
  { pattern: /^chair/i, min: 350, max: 800 },

  // Travel kits
  { pattern: /^travel kit/i, min: 160, max: 320 },
  { pattern: /^TK \d/i, min: 140, max: 300 },

  // T-shirts
  { pattern: /^t shirt/i, min: 100, max: 200 },

  // Caps
  { pattern: /^cap/i, min: 45, max: 85 },
  { pattern: /^CAP/i, min: 45, max: 85 },

  // Sun shades
  { pattern: /^sun shade/i, min: 80, max: 160 },

  // Wallets
  { pattern: /^wallet/i, min: 90, max: 260 },

  // EP (Executive Pens)
  { pattern: /^ep \d/i, min: 60, max: 180 },

  // PS (Pen Sets)
  { pattern: /^PS \d/i, min: 90, max: 220 },
  { pattern: /^ps \d/i, min: 90, max: 220 },

  // PP (Power Pen / Pen Pouch)
  { pattern: /^PP \d/i, min: 40, max: 120 },
  { pattern: /^pp /i, min: 40, max: 120 },

  // P.Box (Presentation Boxes)
  { pattern: /^P\.?Box/i, min: 90, max: 260 },
  { pattern: /^P\.?BOX/i, min: 90, max: 260 },

  // Pencil cases
  { pattern: /^pencil/i, min: 40, max: 100 },

  // Mugs
  { pattern: /^mug/i, min: 40, max: 130 },
  { pattern: /^Mug/i, min: 40, max: 130 },

  // Coasters
  { pattern: /^coaster/i, min: 30, max: 85 },
  { pattern: /^coster/i, min: 30, max: 85 },

  // Cork items (CK)
  { pattern: /^CK \d/i, min: 55, max: 160 },

  // NB (Notebooks)
  { pattern: /^NB SET/i, min: 85, max: 210 },
  { pattern: /^NB Set/i, min: 85, max: 210 },
  { pattern: /^NB \d/i, min: 35, max: 130 },
  { pattern: /^nb \d/i, min: 35, max: 130 },

  // Mouse pads
  { pattern: /^mouse pad/i, min: 50, max: 130 },
  { pattern: /^MOUSE PAD/i, min: 50, max: 130 },

  // MP (Mouse Pads - different category)
  { pattern: /^MP \d/i, min: 50, max: 140 },

  // Flash drives (F = Flash)
  { pattern: /^F \d.*\d+GB/i, min: 45, max: 130 },
  { pattern: /^f \d.*\d+GB/i, min: 45, max: 130 },
  { pattern: /^flash card/i, min: 45, max: 110 },

  // Gift items (G = general gift)
  { pattern: /^G \d/i, min: 20, max: 85 },

  // Spinners
  { pattern: /^spinner/i, min: 20, max: 45 },

  // Pen holders
  { pattern: /^pen holder/i, min: 80, max: 200 },

  // Mobile holders
  { pattern: /^mobile holder/i, min: 80, max: 260 },

  // Porcelain items
  { pattern: /^porce?lin/i, min: 50, max: 150 },

  // Silver / metal items
  { pattern: /^silver/i, min: 60, max: 120 },
  { pattern: /^SILVER GOLD/i, min: 80, max: 160 },

  // Box items
  { pattern: /^box/i, min: 60, max: 180 },

  // Handle items
  { pattern: /handle$/i, min: 60, max: 140 },
];

function assignPrice(name: string): number {
  for (const rule of PRICE_RULES) {
    if (rule.pattern.test(name)) {
      // Add some variation: pick within range with slight randomness
      const range = rule.max - rule.min;
      const base = rule.min + Math.floor(Math.random() * range);
      // Round to nearest 5 for cleaner prices
      return Math.round(base / 5) * 5;
    }
  }
  // Default for unmatched products
  return Math.round((30 + Math.random() * 70) / 5) * 5;
}

async function main() {
  console.log("🔄 Starting price seed...\n");

  const products = await prisma.product.findMany({
    where: { OR: [{ price: 0 }, { price: null }] },
    orderBy: { name: "asc" },
  });

  console.log(`📦 Found ${products.length} products without prices\n`);

  let updated = 0;
  for (const product of products) {
    const price = assignPrice(product.name);
    await prisma.product.update({
      where: { id: product.id },
      data: { price },
    });
    updated++;
    if (updated % 100 === 0 || updated === products.length) {
      console.log(`  ✅ Updated ${updated}/${products.length} — last: "${product.name}" → ${price} EGP`);
    }
  }

  console.log(`\n🎉 Done! Updated ${updated} products with default prices.`);

  // Print summary by category
  const allProducts = await prisma.product.findMany({ select: { name: true, price: true } });
  const categories = new Map<string, { count: number; totalValue: number }>();
  for (const p of allProducts) {
    const cat = guessCategory(p.name);
    const existing = categories.get(cat) || { count: 0, totalValue: 0 };
    existing.count++;
    existing.totalValue += p.price || 0;
    categories.set(cat, existing);
  }

  console.log("\n📊 Price Summary by Category:");
  console.log("─".repeat(60));
  const sorted = [...categories.entries()].sort((a, b) => b[1].totalValue - a[1].totalValue);
  for (const [cat, data] of sorted) {
    const avg = Math.round(data.totalValue / data.count);
    console.log(`  ${cat.padEnd(20)} | ${String(data.count).padStart(3)} products | avg: ${String(avg).padStart(5)} EGP | total: ${String(data.totalValue).padStart(10)} EGP`);
  }

  const grandTotal = allProducts.reduce((sum, p) => sum + (p.price || 0), 0);
  console.log("─".repeat(60));
  console.log(`  ${"TOTAL".padEnd(20)} | ${String(allProducts.length).padStart(3)} products | total: ${String(grandTotal).padStart(10)} EGP`);
}

function guessCategory(name: string): string {
  if (/^power bank|^bank \d|^PB /i.test(name)) return "Power Banks";
  if (/^FL \d/i.test(name)) return "Flash+Power Combos";
  if (/^speaker/i.test(name)) return "Speakers";
  if (/^smart watch/i.test(name)) return "Smart Watches";
  if (/^DC \d/i.test(name)) return "Digital Clocks";
  if (/^lamp usb/i.test(name)) return "USB Lamps";
  if (/^car charger/i.test(name)) return "Car Chargers";
  if (/^mouse/i.test(name)) return "Mice";
  if (/^cable/i.test(name)) return "Cables";
  if (/^conne[ct]or/i.test(name)) return "Connectors";
  if (/^CH \d/i.test(name)) return "Charger Holders";
  if (/^KH \d/i.test(name)) return "Key Holders";
  if (/^bag/i.test(name)) return "Bags";
  if (/^chair/i.test(name)) return "Chairs";
  if (/^travel kit|^TK \d/i.test(name)) return "Travel Kits";
  if (/^t shirt/i.test(name)) return "T-Shirts";
  if (/^cap/i.test(name)) return "Caps";
  if (/^sun shade/i.test(name)) return "Sun Shades";
  if (/^wallet/i.test(name)) return "Wallets";
  if (/^ep \d/i.test(name)) return "Executive Pens";
  if (/^PS \d|^ps \d/i.test(name)) return "Pen Sets";
  if (/^PP \d|^pp /i.test(name)) return "Pen Pouches";
  if (/^P\.?Box|^P\.?BOX/i.test(name)) return "Presentation Boxes";
  if (/^pencil/i.test(name)) return "Pencil Cases";
  if (/^mug/i.test(name)) return "Mugs";
  if (/^coaster|^coster/i.test(name)) return "Coasters";
  if (/^CK \d/i.test(name)) return "Cork Items";
  if (/^NB /i.test(name)) return "Notebooks";
  if (/^mouse pad|^MOUSE PAD/i.test(name)) return "Mouse Pads";
  if (/^MP \d/i.test(name)) return "Mouse Pads";
  if (/^flash card/i.test(name)) return "Flash Cards";
  if (/^F \d.*GB|^f \d.*GB/i.test(name)) return "Flash Drives";
  if (/^G \d/i.test(name)) return "Gift Items";
  if (/^spinner/i.test(name)) return "Spinners";
  if (/^pen holder/i.test(name)) return "Pen Holders";
  if (/^mobile holder/i.test(name)) return "Mobile Holders";
  if (/^porce?lin/i.test(name)) return "Porcelain Items";
  return "Other";
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
