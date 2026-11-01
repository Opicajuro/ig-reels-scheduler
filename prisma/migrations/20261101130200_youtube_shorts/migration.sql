-- YouTube Shorts: the owner's Google OAuth client in the settings, connected channels, their posts and view counts.
-- CreateEnum
CREATE TYPE "YtPrivacy" AS ENUM ('public', 'unlisted', 'private');

-- AlterTable
ALTER TABLE "Setting" ADD COLUMN     "googleClientId" TEXT,
ADD COLUMN     "googleClientSecret" TEXT;

-- CreateTable
CREATE TABLE "YtAccount" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "channelTitle" TEXT NOT NULL,
    "status" "AccountStatus" NOT NULL DEFAULT 'active',
    "refreshToken" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "YtAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "YtPost" (
    "id" TEXT NOT NULL,
    "ytAccountId" TEXT NOT NULL,
    "videoKey" TEXT NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "sourceProjectId" TEXT,
    "sourceClipId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "privacy" "YtPrivacy" NOT NULL,
    "madeForKids" BOOLEAN NOT NULL,
    "aiGenerated" BOOLEAN NOT NULL DEFAULT false,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "status" "PostStatus" NOT NULL DEFAULT 'scheduled',
    "queueJobId" TEXT,
    "uploadUrl" TEXT,
    "videoId" TEXT,
    "url" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "rightsConfirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "YtPost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "YtInsight" (
    "id" TEXT NOT NULL,
    "ytPostId" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "YtInsight_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "YtAccount_channelId_key" ON "YtAccount"("channelId");

-- AddForeignKey
ALTER TABLE "YtAccount" ADD CONSTRAINT "YtAccount_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "YtPost" ADD CONSTRAINT "YtPost_ytAccountId_fkey" FOREIGN KEY ("ytAccountId") REFERENCES "YtAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "YtInsight" ADD CONSTRAINT "YtInsight_ytPostId_fkey" FOREIGN KEY ("ytPostId") REFERENCES "YtPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

