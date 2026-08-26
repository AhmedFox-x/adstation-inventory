// ============================================================================
// src/services/costService.ts — Moving Average Cost Engine
// ============================================================================
// This module handles all cost-related calculations for the inventory system.
//
// Moving Average Cost (MAC) formula:
//   newAvgCost = (oldTotalCost + newPurchaseCost) / (oldTotalQty + newPurchaseQty)
//
// Key rules:
//   - Selling/withdrawing stock does NOT change the average cost
//   - Only purchase receipts (PO receive, supply permit) change the average
//   - Cost is never guessed or estimated — null means "not established"
//   - Each product maintains cumulative totals for accurate calculation
// ============================================================================

import { PrismaClient, Prisma } from "@prisma/client";

type Tx = Prisma.TransactionClient;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ─── Read current average cost from Product snapshot ─────────────────────────
/**
 * Read the current Moving Average Cost for a product.
 * Returns null if no purchase history exists (cost not established).
 */
export async function getCurrentCost(
  tx: Tx,
  productId: string
): Promise<number | null> {
  const product = await tx.product.findUnique({
    where: { id: productId },
    select: { costPrice: true },
  });
  return product?.costPrice ?? null;
}

// ─── Apply a purchase receipt to a product's cost ────────────────────────────
/**
 * Call this when stock is received from a purchase order or supply permit.
 * Updates the Moving Average Cost on the product.
 *
 * @param tx - Transaction client (must be called within prisma.$transaction)
 * @param productId - The product being received
 * @param acceptedQty - Number of units accepted
 * @param unitPrice - Price per unit of this purchase
 * @param orderDate - Optional: date of the order (defaults to now)
 * @returns The new average cost, or null if calculation fails
 */
export async function applyPurchaseToProduct(
  tx: Tx,
  productId: string,
  acceptedQty: number,
  unitPrice: number,
  orderDate?: Date
): Promise<{ newAvgCost: number | null; isFirstPurchase: boolean }> {
  if (acceptedQty <= 0 || unitPrice <= 0) {
    return { newAvgCost: null, isFirstPurchase: false };
  }

  const product = await tx.product.findUnique({
    where: { id: productId },
    select: {
      totalQtyPurchased: true,
      totalCostPurchased: true,
      costPrice: true,
      minPurchasePrice: true,
      maxPurchasePrice: true,
    },
  });

  if (!product) {
    console.error(`[costService] Product not found: ${productId}`);
    return { newAvgCost: null, isFirstPurchase: false };
  }

  const oldQty = product.totalQtyPurchased;
  const oldCost = product.totalCostPurchased;
  const isFirst = oldQty === 0;

  const newPurchaseCost = round2(unitPrice * acceptedQty);
  const newTotalQty = oldQty + acceptedQty;
  const newTotalCost = oldCost + newPurchaseCost;

  // Moving Average Cost
  const newAvg = newTotalQty > 0 ? round2(newTotalCost / newTotalQty) : null;

  // Min / Max price tracking
  const minPrice = isFirst
    ? unitPrice
    : Math.min(product.minPurchasePrice ?? unitPrice, unitPrice);
  const maxPrice = isFirst
    ? unitPrice
    : Math.max(product.maxPurchasePrice ?? unitPrice, unitPrice);

  await tx.product.update({
    where: { id: productId },
    data: {
      costPrice: newAvg,
      lastPurchasePrice: unitPrice,
      maxPurchasePrice: maxPrice,
      minPurchasePrice: minPrice,
      lastPurchaseDate: orderDate || new Date(),
      totalQtyPurchased: newTotalQty,
      totalCostPurchased: newTotalCost,
    },
  });

  return { newAvgCost: newAvg, isFirstPurchase: isFirst };
}

// ─── Calculate withdrawal cost (does NOT change average) ─────────────────────
/**
 * Calculate the cost of a stock withdrawal based on current average.
 * Returns null if cost is not established.
 *
 * IMPORTANT: This does NOT update the average cost — selling/withdrawing
 * does not change MAC.
 */
export async function calculateWithdrawalCost(
  tx: Tx,
  productId: string,
  quantity: number
): Promise<{ unitCost: number | null; totalCost: number | null }> {
  const cost = await getCurrentCost(tx, productId);
  if (cost === null || cost <= 0) {
    return { unitCost: null, totalCost: null };
  }
  return {
    unitCost: cost,
    totalCost: round2(cost * quantity),
  };
}

// ─── Snapshot cost at time of sale ───────────────────────────────────────────
/**
 * Get a cost snapshot for recording on a sales order item.
 * This captures the cost at this moment and should NOT change later.
 */
export async function getCostSnapshot(
  tx: Tx,
  productId: string
): Promise<number> {
  const cost = await getCurrentCost(tx, productId);
  return cost ?? 0;
}

// ─── Calculate margin ────────────────────────────────────────────────────────
/**
 * Calculate profit margin percentage.
 * Returns null if cost is not established.
 */
export function calculateMargin(
  sellingPrice: number,
  costPrice: number | null
): number | null {
  if (costPrice === null || costPrice <= 0 || sellingPrice <= 0) return null;
  return round2(((sellingPrice - costPrice) / costPrice) * 100);
}
