-- CreateEnum
CREATE TYPE "AudioSource" AS ENUM ('original', 'licensed', 'from_source', 'unknown');

-- AlterTable
ALTER TABLE "Media" ADD COLUMN     "audioSource" "AudioSource" NOT NULL DEFAULT 'unknown',
ADD COLUMN     "sourceProjectId" TEXT;

-- AlterTable
ALTER TABLE "Post" ADD COLUMN     "rightsConfirmedAt" TIMESTAMP(3);
