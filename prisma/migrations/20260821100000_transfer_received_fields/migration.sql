-- AlterTable: Add receivedBy/receivedByName/receivedAt to Transfer
ALTER TABLE "Transfer" ADD COLUMN "receivedBy" TEXT,
ADD COLUMN "receivedByName" TEXT,
ADD COLUMN "receivedAt" TIMESTAMP(3);
