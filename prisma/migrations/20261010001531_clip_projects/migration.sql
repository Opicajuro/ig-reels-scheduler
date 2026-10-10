-- CreateEnum
CREATE TYPE "ClipProjectStatus" AS ENUM ('awaiting_source', 'ready', 'rendering', 'done', 'failed');

-- CreateTable
CREATE TABLE "ClipProject" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "sourceKey" TEXT,
    "status" "ClipProjectStatus" NOT NULL DEFAULT 'awaiting_source',
    "error" TEXT,
    "durationSeconds" INTEGER,
    "clipSeconds" INTEGER NOT NULL DEFAULT 30,
    "clipCount" INTEGER NOT NULL DEFAULT 3,
    "withCaptions" BOOLEAN NOT NULL DEFAULT false,
    "captionPreset" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClipProject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Clip" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "start" INTEGER NOT NULL,
    "length" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "title" TEXT,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Clip_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "ClipProject" ADD CONSTRAINT "ClipProject_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Clip" ADD CONSTRAINT "Clip_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "ClipProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
