-- AlterTable
ALTER TABLE "PurchaseOrder" ADD COLUMN "sentAt" TIMESTAMP(3),
ADD COLUMN "sentBy" TEXT,
ADD COLUMN "sentChannel" TEXT,
ADD COLUMN "sentRecipient" TEXT,
ADD COLUMN "sentMessageId" TEXT;
