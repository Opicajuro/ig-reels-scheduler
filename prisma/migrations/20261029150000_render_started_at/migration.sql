-- AlterTable
ALTER TABLE "ClipProject" ADD COLUMN     "renderStartedAt" TIMESTAMP(3);

-- Projects already making clips when this arrives count from now.
UPDATE "ClipProject" SET "renderStartedAt" = CURRENT_TIMESTAMP WHERE "status" = 'rendering';
