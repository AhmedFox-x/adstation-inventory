-- AlterTable: Product — reorder engine fields
ALTER TABLE "Product" ADD COLUMN "reorderPoint" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Product" ADD COLUMN "maxStock" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Product" ADD COLUMN "safetyStock" INTEGER NOT NULL DEFAULT 0;

-- AlterTable: PurchaseOrder — soft delete
ALTER TABLE "PurchaseOrder" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "PurchaseOrder" ADD COLUMN "deletedBy" TEXT;

-- AlterTable: StocktakeSession — soft delete
ALTER TABLE "StocktakeSession" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "StocktakeSession" ADD COLUMN "deletedBy" TEXT;

-- AlterTable: WithdrawalPermit — soft delete
ALTER TABLE "WithdrawalPermit" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "WithdrawalPermit" ADD COLUMN "deletedBy" TEXT;

-- AlterTable: SupplyPermit — soft delete
ALTER TABLE "SupplyPermit" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "SupplyPermit" ADD COLUMN "deletedBy" TEXT;

-- AlterTable: Reservation — soft delete
ALTER TABLE "Reservation" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "Reservation" ADD COLUMN "deletedBy" TEXT;

-- AlterTable: Transfer — soft delete
ALTER TABLE "Transfer" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "Transfer" ADD COLUMN "deletedBy" TEXT;
