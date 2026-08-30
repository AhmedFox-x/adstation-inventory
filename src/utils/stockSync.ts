/**
 * stockSync.ts — Centralized WarehouseStock synchronization
 *
 * Every operation that changes Product.stock MUST also update WarehouseStock
 * using these helpers. This prevents Product.stock and WarehouseStock.quantity
 * from drifting apart.
 *
 * All functions are designed to run INSIDE an existing prisma.$transaction.
 */

import { PrismaClient } from "@prisma/client";

type PrismaTx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

/** Find or create WarehouseStock row for a product in a warehouse */
async function findOrCreateWarehouseStock(
  tx: PrismaTx,
  warehouseId: string,
  productId: string
) {
  let ws = await tx.warehouseStock.findUnique({
    where: { warehouseId_productId: { warehouseId, productId } },
  });
  if (!ws) {
    ws = await tx.warehouseStock.create({
      data: { warehouseId, productId, quantity: 0, reservedQuantity: 0 },
    });
  }
  return ws;
}

/**
 * Get the default main warehouse ID.
 * Uses the first active warehouse ordered by creation.
 * Call this inside a transaction to ensure consistency.
 */
export async function getDefaultWarehouseId(tx: PrismaTx): Promise<string> {
  const wh = await tx.warehouse.findFirst({
    where: { isActive: true, deletedAt: null },
    orderBy: { createdAt: "asc" },
  });
  if (!wh) throw new Error("No active warehouse found for stock sync");
  return wh.id;
}

/**
 * Increment WarehouseStock quantity for a product in a warehouse.
 * Used by: PO Receive, Supply Permit, Customer Return.
 */
export async function incrementWarehouseStock(
  tx: PrismaTx,
  warehouseId: string,
  productId: string,
  quantity: number
) {
  if (quantity <= 0) return;
  await tx.warehouseStock.upsert({
    where: { warehouseId_productId: { warehouseId, productId } },
    create: { warehouseId, productId, quantity, reservedQuantity: 0 },
    update: { quantity: { increment: quantity } },
  });
}

/**
 * Decrement WarehouseStock quantity for a product in a warehouse.
 * Used by: Withdrawal Permit, SO Delivery, Supplier Return, Reservation Fulfill.
 */
export async function decrementWarehouseStock(
  tx: PrismaTx,
  warehouseId: string,
  productId: string,
  quantity: number
) {
  if (quantity <= 0) return;
  await tx.warehouseStock.upsert({
    where: { warehouseId_productId: { warehouseId, productId } },
    create: { warehouseId, productId, quantity: 0, reservedQuantity: 0 },
    update: { quantity: { decrement: quantity } },
  });
}

/**
 * Set WarehouseStock quantity to an absolute value for a product in a warehouse.
 * Used by: Stocktake approve, Manual product edit, Scan confirm.
 */
export async function setWarehouseStock(
  tx: PrismaTx,
  warehouseId: string,
  productId: string,
  quantity: number
) {
  await tx.warehouseStock.upsert({
    where: { warehouseId_productId: { warehouseId, productId } },
    create: { warehouseId, productId, quantity, reservedQuantity: 0 },
    update: { quantity },
  });
}

/**
 * Increment WarehouseStock reservedQuantity for a product in a warehouse.
 * Used by: SO Confirm (reserve), Manual Reservation.
 */
export async function incrementReservedStock(
  tx: PrismaTx,
  warehouseId: string,
  productId: string,
  quantity: number
) {
  if (quantity <= 0) return;
  await tx.warehouseStock.upsert({
    where: { warehouseId_productId: { warehouseId, productId } },
    create: { warehouseId, productId, quantity: 0, reservedQuantity: quantity },
    update: { reservedQuantity: { increment: quantity } },
  });
}

/**
 * Decrement WarehouseStock reservedQuantity for a product in a warehouse.
 * Used by: SO Delivery, SO Cancel, SO Expire, Reservation Cancel.
 */
export async function decrementReservedStock(
  tx: PrismaTx,
  warehouseId: string,
  productId: string,
  quantity: number
) {
  if (quantity <= 0) return;
  await tx.warehouseStock.upsert({
    where: { warehouseId_productId: { warehouseId, productId } },
    create: { warehouseId, productId, quantity: 0, reservedQuantity: 0 },
    update: { reservedQuantity: { decrement: quantity } },
  });
}

/**
 * Increment WarehouseStock quarantineStock (stored in quantity field with negative? No — quarantine is on Product model).
 * For quarantine returns, we update the main warehouse stock.
 * Note: Product.quarantineStock is a separate counter. WarehouseStock tracks physical quantity.
 */
export async function incrementQuarantineWarehouseStock(
  tx: PrismaTx,
  warehouseId: string,
  productId: string,
  quantity: number
) {
  // Quarantine items stay in the same warehouse physically but are tracked separately.
  // We still increment the warehouse physical quantity because they are physically present.
  await incrementWarehouseStock(tx, warehouseId, productId, quantity);
}

/**
 * Perform stock delta on WarehouseStock (positive = increment, negative = decrement).
 * Generic helper for cases where direction is computed at runtime.
 */
export async function deltaWarehouseStock(
  tx: PrismaTx,
  warehouseId: string,
  productId: string,
  delta: number
) {
  if (delta > 0) {
    await incrementWarehouseStock(tx, warehouseId, productId, delta);
  } else if (delta < 0) {
    await decrementWarehouseStock(tx, warehouseId, productId, Math.abs(delta));
  }
}
