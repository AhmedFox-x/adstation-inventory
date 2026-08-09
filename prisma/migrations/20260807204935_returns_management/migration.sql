-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "quarantineStock" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "ReturnOrder" (
    "id" TEXT NOT NULL,
    "returnNumber" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "sourceNumber" TEXT,
    "partyId" TEXT,
    "partyName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "warehouseDestination" TEXT NOT NULL DEFAULT 'returns',
    "subtotal" DOUBLE PRECISION DEFAULT 0,
    "refundAmount" DOUBLE PRECISION DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'EGP',
    "notes" TEXT,
    "images" JSONB,
    "createdBy" TEXT,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectedBy" TEXT,
    "rejectedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "receivedBy" TEXT,
    "receivedAt" TIMESTAMP(3),
    "closedBy" TEXT,
    "closedAt" TIMESTAMP(3),
    "refundStatus" TEXT NOT NULL DEFAULT 'none',
    "refundDate" TIMESTAMP(3),
    "refundNote" TEXT,
    "refundDueAt" TIMESTAMP(3),
    "resolution" TEXT,
    "replacementOrderId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReturnOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReturnOrderItem" (
    "id" TEXT NOT NULL,
    "returnId" TEXT NOT NULL,
    "sourceItemId" TEXT,
    "productId" TEXT NOT NULL,
    "productName" TEXT,
    "productSku" TEXT,
    "unit" TEXT,
    "condition" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "returnedQty" INTEGER NOT NULL,
    "receivedQty" INTEGER NOT NULL DEFAULT 0,
    "unitPrice" DOUBLE PRECISION DEFAULT 0,
    "totalPrice" DOUBLE PRECISION DEFAULT 0,
    "imageBefore" TEXT,
    "imageAfter" TEXT,
    "notes" TEXT,

    CONSTRAINT "ReturnOrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReturnOrderStatusHistory" (
    "id" TEXT NOT NULL,
    "returnId" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT NOT NULL,
    "changedBy" TEXT,
    "note" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "beforeState" JSONB,
    "afterState" JSONB,
    "changedFields" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReturnOrderStatusHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReturnOrder_returnNumber_key" ON "ReturnOrder"("returnNumber");

-- CreateIndex
CREATE INDEX "ReturnOrder_status_createdAt_idx" ON "ReturnOrder"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ReturnOrder_type_idx" ON "ReturnOrder"("type");

-- CreateIndex
CREATE INDEX "ReturnOrder_sourceType_sourceId_idx" ON "ReturnOrder"("sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "ReturnOrder_partyId_idx" ON "ReturnOrder"("partyId");

-- CreateIndex
CREATE INDEX "ReturnOrder_createdBy_idx" ON "ReturnOrder"("createdBy");

-- CreateIndex
CREATE INDEX "ReturnOrderItem_returnId_idx" ON "ReturnOrderItem"("returnId");

-- CreateIndex
CREATE INDEX "ReturnOrderItem_productId_idx" ON "ReturnOrderItem"("productId");

-- CreateIndex
CREATE INDEX "ReturnOrderItem_sourceItemId_idx" ON "ReturnOrderItem"("sourceItemId");

-- CreateIndex
CREATE INDEX "ReturnOrderStatusHistory_returnId_createdAt_idx" ON "ReturnOrderStatusHistory"("returnId", "createdAt");

-- CreateIndex
CREATE INDEX "ReturnOrderStatusHistory_returnId_idx" ON "ReturnOrderStatusHistory"("returnId");

-- AddForeignKey
ALTER TABLE "ReturnOrderItem" ADD CONSTRAINT "ReturnOrderItem_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES "ReturnOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnOrderItem" ADD CONSTRAINT "ReturnOrderItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnOrderStatusHistory" ADD CONSTRAINT "ReturnOrderStatusHistory_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES "ReturnOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
