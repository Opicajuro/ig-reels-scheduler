-- "Tighten pacing": a clip project option that shrinks long pauses and cuts lone filler words inside each clip.
-- AlterTable
ALTER TABLE "ClipProject" ADD COLUMN     "tightenPacing" BOOLEAN NOT NULL DEFAULT false;
