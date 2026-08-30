-- AlterTable
ALTER TABLE "Product" ALTER COLUMN "unit" SET DEFAULT '┘é╪╖╪╣╪⌐';

-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "priceListId" TEXT;

-- AlterTable
ALTER TABLE "SalesOrderItem" ADD COLUMN     "listPrice" DOUBLE PRECISION,
ADD COLUMN     "listTier" TEXT;

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "category" TEXT,
ADD COLUMN     "resolvedAt" TIMESTAMP(3),
ADD COLUMN     "resolvedBy" TEXT,
ADD COLUMN     "severity" TEXT NOT NULL DEFAULT 'normal',
ADD COLUMN     "snoozedUntil" TIMESTAMP(3),
ADD COLUMN     "sourceKey" TEXT;

-- CreateTable
CREATE TABLE "PriceList" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tier" TEXT NOT NULL DEFAULT 'retail',
    "currency" TEXT NOT NULL DEFAULT 'EGP',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "clientId" TEXT,
    "notes" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PriceList_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceListItem" (
    "id" TEXT NOT NULL,
    "priceListId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "minPrice" DOUBLE PRECISION,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PriceListItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Anomaly" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'medium',
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "entityType" TEXT,
    "entityName" TEXT,
    "entityId" TEXT,
    "referenceType" TEXT,
    "referenceId" TEXT,
    "details" JSONB,
    "sourceLogId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "timesSeen" INTEGER NOT NULL DEFAULT 1,
    "resolutionNote" TEXT,
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Anomaly_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PriceList_clientId_key" ON "PriceList"("clientId");

-- CreateIndex
CREATE INDEX "PriceList_tier_idx" ON "PriceList"("tier");

-- CreateIndex
CREATE INDEX "PriceList_isActive_idx" ON "PriceList"("isActive");

-- CreateIndex
CREATE INDEX "PriceListItem_productId_idx" ON "PriceListItem"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "PriceListItem_priceListId_productId_key" ON "PriceListItem"("priceListId", "productId");

-- CreateIndex
CREATE INDEX "Anomaly_status_idx" ON "Anomaly"("status");

-- CreateIndex
CREATE INDEX "Anomaly_code_status_idx" ON "Anomaly"("code", "status");

-- CreateIndex
CREATE INDEX "Anomaly_entityId_idx" ON "Anomaly"("entityId");

-- CreateIndex
CREATE INDEX "Anomaly_createdAt_idx" ON "Anomaly"("createdAt");

-- CreateIndex
CREATE INDEX "Anomaly_code_entityType_entityId_status_idx" ON "Anomaly"("code", "entityType", "entityId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Client_priceListId_key" ON "Client"("priceListId");

-- CreateIndex
CREATE INDEX "Client_priceListId_idx" ON "Client"("priceListId");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_sourceKey_key" ON "Notification"("sourceKey");

-- CreateIndex
CREATE INDEX "Notification_category_createdAt_idx" ON "Notification"("category", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_severity_idx" ON "Notification"("severity");

-- AddForeignKey
ALTER TABLE "Client" ADD CONSTRAINT "Client_priceListId_fkey" FOREIGN KEY ("priceListId") REFERENCES "PriceList"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceList" ADD CONSTRAINT "PriceList_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceListItem" ADD CONSTRAINT "PriceListItem_priceListId_fkey" FOREIGN KEY ("priceListId") REFERENCES "PriceList"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceListItem" ADD CONSTRAINT "PriceListItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

