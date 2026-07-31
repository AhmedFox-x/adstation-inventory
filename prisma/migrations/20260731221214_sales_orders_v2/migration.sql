-- DropIndex
DROP INDEX "SalesOrder_clientId_idx";

-- DropIndex
DROP INDEX "SalesOrder_status_idx";

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "brand" TEXT,
ADD COLUMN     "unit" TEXT NOT NULL DEFAULT 'قطعة';

-- AlterTable
ALTER TABLE "Reservation" ADD COLUMN     "fulfilledQty" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "salesOrderItemId" TEXT,
ADD COLUMN     "warehouseId" TEXT;

-- AlterTable
ALTER TABLE "SalesOrder" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedBy" TEXT,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "SalesOrderItem" ADD COLUMN     "barcode" TEXT,
ADD COLUMN     "brand" TEXT,
ADD COLUMN     "category" TEXT,
ADD COLUMN     "currency" TEXT DEFAULT 'EGP',
ADD COLUMN     "discountRate" DOUBLE PRECISION DEFAULT 0,
ADD COLUMN     "exchangeRate" DOUBLE PRECISION DEFAULT 1,
ADD COLUMN     "productName" TEXT,
ADD COLUMN     "productSku" TEXT,
ADD COLUMN     "taxRate" DOUBLE PRECISION DEFAULT 0,
ADD COLUMN     "unit" TEXT;

-- AlterTable
ALTER TABLE "SalesOrderStatusHistory" ADD COLUMN     "afterState" JSONB,
ADD COLUMN     "beforeState" JSONB,
ADD COLUMN     "changedFields" TEXT[],
ADD COLUMN     "ip" TEXT,
ADD COLUMN     "userAgent" TEXT;

-- CreateTable
CREATE TABLE "SystemSettings" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesOrderApproval" (
    "id" TEXT NOT NULL,
    "salesOrderId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "requestedBy" TEXT,
    "approvedBy" TEXT,
    "rejectedBy" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),

    CONSTRAINT "SalesOrderApproval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesDelivery" (
    "id" TEXT NOT NULL,
    "salesOrderId" TEXT NOT NULL,
    "deliveryNumber" TEXT NOT NULL,
    "deliveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredBy" TEXT,
    "driverName" TEXT,
    "vehicle" TEXT,
    "proofImage" TEXT,
    "signature" TEXT,
    "gpsLocation" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SalesDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesDeliveryItem" (
    "id" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "salesOrderItemId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit" TEXT,

    CONSTRAINT "SalesDeliveryItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "referenceType" TEXT,
    "referenceId" TEXT,
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "icon" TEXT,
    "actionUrl" TEXT,
    "createdBySystem" BOOLEAN NOT NULL DEFAULT false,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "readAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SystemSettings_key_key" ON "SystemSettings"("key");

-- CreateIndex
CREATE INDEX "SalesOrderApproval_salesOrderId_status_idx" ON "SalesOrderApproval"("salesOrderId", "status");

-- CreateIndex
CREATE INDEX "SalesOrderApproval_salesOrderId_idx" ON "SalesOrderApproval"("salesOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "SalesDelivery_deliveryNumber_key" ON "SalesDelivery"("deliveryNumber");

-- CreateIndex
CREATE INDEX "SalesDelivery_salesOrderId_idx" ON "SalesDelivery"("salesOrderId");

-- CreateIndex
CREATE INDEX "SalesDelivery_deliveredAt_idx" ON "SalesDelivery"("deliveredAt");

-- CreateIndex
CREATE INDEX "SalesDeliveryItem_deliveryId_idx" ON "SalesDeliveryItem"("deliveryId");

-- CreateIndex
CREATE INDEX "Notification_userId_isRead_createdAt_idx" ON "Notification"("userId", "isRead", "createdAt");

-- CreateIndex
CREATE INDEX "Reservation_salesOrderItemId_idx" ON "Reservation"("salesOrderItemId");

-- CreateIndex
CREATE INDEX "SalesOrder_orderNumber_idx" ON "SalesOrder"("orderNumber");

-- CreateIndex
CREATE INDEX "SalesOrder_status_createdAt_idx" ON "SalesOrder"("status", "createdAt");

-- CreateIndex
CREATE INDEX "SalesOrder_clientId_createdAt_idx" ON "SalesOrder"("clientId", "createdAt");

-- CreateIndex
CREATE INDEX "SalesOrder_expectedDeliveryDate_idx" ON "SalesOrder"("expectedDeliveryDate");

-- CreateIndex
CREATE INDEX "SalesOrderItem_productId_idx" ON "SalesOrderItem"("productId");

-- CreateIndex
CREATE INDEX "SalesOrderItem_orderId_idx" ON "SalesOrderItem"("orderId");

-- CreateIndex
CREATE INDEX "SalesOrderStatusHistory_orderId_createdAt_idx" ON "SalesOrderStatusHistory"("orderId", "createdAt");

-- AddForeignKey
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_salesOrderItemId_fkey" FOREIGN KEY ("salesOrderItemId") REFERENCES "SalesOrderItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesOrderApproval" ADD CONSTRAINT "SalesOrderApproval_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "SalesOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesDelivery" ADD CONSTRAINT "SalesDelivery_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "SalesOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesDeliveryItem" ADD CONSTRAINT "SalesDeliveryItem_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "SalesDelivery"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesDeliveryItem" ADD CONSTRAINT "SalesDeliveryItem_salesOrderItemId_fkey" FOREIGN KEY ("salesOrderItemId") REFERENCES "SalesOrderItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesDeliveryItem" ADD CONSTRAINT "SalesDeliveryItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
