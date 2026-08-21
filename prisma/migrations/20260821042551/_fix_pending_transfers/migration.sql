-- Fix any remaining pending transfers from old workflow
UPDATE "Transfer" SET "status" = 'draft' WHERE "status" = 'pending';
