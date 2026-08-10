-- P5 Advanced Audit Trail
-- 1) Product soft-delete column
ALTER TABLE "Product" ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- 2) InventoryLog audit fields (actor identity + unified entity reference + before/after snapshots)
ALTER TABLE "InventoryLog" ADD COLUMN     "userId" TEXT,
ADD COLUMN     "userName" TEXT,
ADD COLUMN     "userRole" TEXT,
ADD COLUMN     "entityType" TEXT,
ADD COLUMN     "entityId" TEXT,
ADD COLUMN     "beforeData" JSONB,
ADD COLUMN     "afterData" JSONB;

-- 3) Indexes for audit filtering/pagination performance
CREATE INDEX "InventoryLog_userId_idx" ON "InventoryLog"("userId");
CREATE INDEX "InventoryLog_entityType_entityId_idx" ON "InventoryLog"("entityType", "entityId");
CREATE INDEX "InventoryLog_type_idx" ON "InventoryLog"("type");
CREATE INDEX "InventoryLog_createdAt_idx" ON "InventoryLog"("createdAt");
