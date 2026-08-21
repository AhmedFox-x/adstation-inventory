-- AlterTable: Add new workflow columns to Transfer
ALTER TABLE "Transfer" ADD COLUMN "confirmedBy" TEXT,
ADD COLUMN "confirmedByName" TEXT,
ADD COLUMN "confirmedAt" TIMESTAMP(3),
ADD COLUMN "cancelledBy" TEXT,
ADD COLUMN "cancelledByName" TEXT,
ADD COLUMN "cancelledAt" TIMESTAMP(3),
ADD COLUMN "cancelNote" TEXT;

-- Update default status from 'pending' to 'draft'
ALTER TABLE "Transfer" ALTER COLUMN "status" SET DEFAULT 'draft';

-- Migrate existing 'pending' status to 'draft'
UPDATE "Transfer" SET "status" = 'draft' WHERE "status" = 'pending';
