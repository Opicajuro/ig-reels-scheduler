-- AlterTable
ALTER TABLE "IgAccount" ADD COLUMN     "lockedUntil" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Post" ADD COLUMN     "queueJobId" TEXT;
