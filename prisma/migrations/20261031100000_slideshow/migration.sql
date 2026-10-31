-- Slideshows on the Clips page: the install state of their two offline engines, the slideshows asked for, and the
-- owner's "Slideshows" project that holds the clips they make.
CREATE TYPE "SlideshowStatus" AS ENUM ('writing', 'draft', 'queued', 'running', 'done', 'failed');

ALTER TABLE "ClipProject" ADD COLUMN "slideshows" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "SlideshowEngine" (
    "id" TEXT NOT NULL,
    "status" "AiEngineStatus" NOT NULL DEFAULT 'not_installed',
    "step" TEXT,
    "percent" INTEGER,
    "error" TEXT,
    "installedBytes" BIGINT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SlideshowEngine_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SlideshowJob" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "slideCount" INTEGER NOT NULL,
    "slides" JSONB,
    "voice" TEXT NOT NULL DEFAULT 'af_heart',
    "captionPreset" TEXT NOT NULL DEFAULT 'words',
    "status" "SlideshowStatus" NOT NULL DEFAULT 'writing',
    "step" TEXT,
    "error" TEXT,
    "clipId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SlideshowJob_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SlideshowJob_clipId_key" ON "SlideshowJob"("clipId");

ALTER TABLE "SlideshowJob" ADD CONSTRAINT "SlideshowJob_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SlideshowJob" ADD CONSTRAINT "SlideshowJob_clipId_fkey" FOREIGN KEY ("clipId") REFERENCES "Clip"("id") ON DELETE SET NULL ON UPDATE CASCADE;
