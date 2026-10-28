-- The offline AI video engine on /ai: its install state (one row), the videos asked for, and which clips and project
-- they made.
CREATE TYPE "AiEngineStatus" AS ENUM ('not_installed', 'installing', 'installed', 'failed');

CREATE TYPE "AiVideoStatus" AS ENUM ('queued', 'running', 'done', 'failed');

ALTER TABLE "Clip" ADD COLUMN "aiGenerated" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "ClipProject" ADD COLUMN "aiVideos" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "AiEngine" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "status" "AiEngineStatus" NOT NULL DEFAULT 'not_installed',
    "step" TEXT,
    "percent" INTEGER,
    "error" TEXT,
    "installedBytes" BIGINT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiEngine_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AiVideoJob" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "seconds" INTEGER NOT NULL,
    "startImageKey" TEXT,
    "status" "AiVideoStatus" NOT NULL DEFAULT 'queued',
    "step" TEXT,
    "error" TEXT,
    "clipId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiVideoJob_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AiVideoJob_clipId_key" ON "AiVideoJob"("clipId");

ALTER TABLE "AiVideoJob" ADD CONSTRAINT "AiVideoJob_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AiVideoJob" ADD CONSTRAINT "AiVideoJob_clipId_fkey" FOREIGN KEY ("clipId") REFERENCES "Clip"("id") ON DELETE SET NULL ON UPDATE CASCADE;
