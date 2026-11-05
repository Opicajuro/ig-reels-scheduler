-- Facebook Page Reels and TikTok drafts: the Facebook Login for Business configuration and the TikTok app in the
-- settings, connected Pages and TikTok accounts, and their posts.
-- AlterTable
ALTER TABLE "Setting" ADD COLUMN     "fbLoginConfigId" TEXT,
ADD COLUMN     "tiktokClientKey" TEXT,
ADD COLUMN     "tiktokClientSecret" TEXT;

-- CreateTable
CREATE TABLE "FbPage" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "AccountStatus" NOT NULL DEFAULT 'active',
    "pageToken" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FbPage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FbPost" (
    "id" TEXT NOT NULL,
    "fbPageId" TEXT NOT NULL,
    "videoKey" TEXT NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "sourceProjectId" TEXT,
    "sourceClipId" TEXT,
    "description" TEXT NOT NULL,
    "aiGenerated" BOOLEAN NOT NULL DEFAULT false,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "status" "PostStatus" NOT NULL DEFAULT 'scheduled',
    "queueJobId" TEXT,
    "videoId" TEXT,
    "fbPostId" TEXT,
    "permalink" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "rightsConfirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FbPost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TtAccount" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "openId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "status" "AccountStatus" NOT NULL DEFAULT 'active',
    "refreshToken" TEXT,
    "accessToken" TEXT,
    "accessExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TtAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TtPost" (
    "id" TEXT NOT NULL,
    "ttAccountId" TEXT NOT NULL,
    "videoKey" TEXT NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "sourceProjectId" TEXT,
    "sourceClipId" TEXT,
    "caption" TEXT NOT NULL,
    "aiGenerated" BOOLEAN NOT NULL DEFAULT false,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "status" "PostStatus" NOT NULL DEFAULT 'scheduled',
    "queueJobId" TEXT,
    "publishId" TEXT,
    "uploadUrl" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "rightsConfirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TtPost_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FbPage_pageId_key" ON "FbPage"("pageId");

-- CreateIndex
CREATE UNIQUE INDEX "TtAccount_openId_key" ON "TtAccount"("openId");

-- AddForeignKey
ALTER TABLE "FbPage" ADD CONSTRAINT "FbPage_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FbPost" ADD CONSTRAINT "FbPost_fbPageId_fkey" FOREIGN KEY ("fbPageId") REFERENCES "FbPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TtAccount" ADD CONSTRAINT "TtAccount_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TtPost" ADD CONSTRAINT "TtPost_ttAccountId_fkey" FOREIGN KEY ("ttAccountId") REFERENCES "TtAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
