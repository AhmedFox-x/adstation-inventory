-- BUG FIX: schema.prisma declares cost-tracking columns on Product and
-- SupplyItem.unitPrice, but no migration ever created them (same class of bug as
-- the missing Warehouse/Transfer tables). This migration reconciles the
-- remaining drift so the resulting DB schema matches schema.prisma.

-- AlterTable: Product — selling floor + cost tracking (Moving Average)
ALTER TABLE "Product" ADD COLUMN "minSellingPrice" DOUBLE PRECISION,
ADD COLUMN "costPrice" DOUBLE PRECISION,
ADD COLUMN "lastPurchasePrice" DOUBLE PRECISION,
ADD COLUMN "maxPurchasePrice" DOUBLE PRECISION,
ADD COLUMN "minPurchasePrice" DOUBLE PRECISION,
ADD COLUMN "lastPurchaseDate" TIMESTAMP(3),
ADD COLUMN "totalQtyPurchased" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "totalCostPurchased" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- AlterTable: SupplyItem — unitPrice
ALTER TABLE "SupplyItem" ADD COLUMN "unitPrice" DOUBLE PRECISION DEFAULT 0;