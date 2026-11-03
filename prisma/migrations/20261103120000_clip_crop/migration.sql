-- "Crop": how a clip project takes its 9:16 picture from the source. Existing projects keep the centre crop they were
-- made with; new projects follow the action.
-- AlterTable
ALTER TABLE "ClipProject" ADD COLUMN     "crop" TEXT NOT NULL DEFAULT 'centre';
ALTER TABLE "ClipProject" ALTER COLUMN "crop" SET DEFAULT 'follow';
