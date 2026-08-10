/**
 * Barcode generation utility for AD Station products.
 * Format: AD-XXXXXXXX (8 alphanumeric chars, uppercase).
 * Collision-resistant: checks DB before confirming.
 */

import { prisma } from "../config/database";
import { customAlphabet } from "nanoid";

const generateId = customAlphabet("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", 8);

export async function generateUniqueBarcode(): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = `AD-${generateId()}`;
    const exists = await prisma.product.findUnique({ where: { barcode: code } });
    if (!exists) return code;
  }
  throw new Error("Failed to generate unique barcode after 10 attempts");
}

/**
 * Assign barcodes to all products that don't have one yet.
 * Returns count of products updated.
 */
export async function seedBarcodes(): Promise<number> {
  const products = await prisma.product.findMany({
    where: { barcode: null, deletedAt: null },
    select: { id: true },
  });

  if (products.length === 0) return 0;

  let count = 0;
  for (const p of products) {
    const barcode = await generateUniqueBarcode();
    await prisma.product.update({
      where: { id: p.id },
      data: { barcode },
    });
    count++;
  }

  console.log(`[Barcode] Assigned barcodes to ${count} products`);
  return count;
}
