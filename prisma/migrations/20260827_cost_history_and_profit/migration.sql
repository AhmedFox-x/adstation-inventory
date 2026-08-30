-- CreateTable
CREATE TABLE "CostHistory" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "oldCost" DOUBLE PRECISION,
    "newCost" DOUBLE PRECISION,
    "change" DOUBLE PRECISION,
    "reason" TEXT NOT NULL,
    "purchasePrice" DOUBLE PRECISION,
    "referenceType" TEXT,
    "referenceId" TEXT,
    "userId" TEXT,
    "userName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CostHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CostHistory_productId_createdAt_idx" ON "CostHistory"("productId", "createdAt");

-- CreateIndex
CREATE INDEX "CostHistory_referenceType_referenceId_idx" ON "CostHistory"("referenceType", "referenceId");

-- AddForeignKey
ALTER TABLE "CostHistory" ADD CONSTRAINT "CostHistory_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "SalesOrder" ADD COLUMN "totalProfit" DOUBLE PRECISION,
ADD COLUMN "totalMarginPct" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "SalesOrderItem" ADD COLUMN "grossProfit" DOUBLE PRECISION,
ADD COLUMN "marginPct" DOUBLE PRECISION;
