-- Background music from the built-in library: a track and volume per clip project and per slideshow, and the track a
-- clip was made with, for its credit line.
-- AlterTable
ALTER TABLE "ClipProject" ADD COLUMN     "musicTrack" TEXT,
ADD COLUMN     "musicVolume" INTEGER NOT NULL DEFAULT 15;

-- AlterTable
ALTER TABLE "Clip" ADD COLUMN     "musicTrack" TEXT;

-- AlterTable
ALTER TABLE "SlideshowJob" ADD COLUMN     "musicTrack" TEXT,
ADD COLUMN     "musicVolume" INTEGER NOT NULL DEFAULT 15;
