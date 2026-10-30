-- CreateEnum
CREATE TYPE "BackupStatus" AS ENUM ('running', 'ok', 'failed');

-- CreateTable
CREATE TABLE "BackupSettings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "folder" TEXT,
    "includeClips" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "BackupSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Backup" (
    "id" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "path" TEXT NOT NULL,
    "includeClips" BOOLEAN NOT NULL,
    "status" "BackupStatus" NOT NULL DEFAULT 'running',
    "sizeBytes" BIGINT,
    "error" TEXT,

    CONSTRAINT "Backup_pkey" PRIMARY KEY ("id")
);

