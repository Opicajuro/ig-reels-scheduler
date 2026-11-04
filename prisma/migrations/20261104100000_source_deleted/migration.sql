-- "Delete source video" on the Storage page: when a project's source video was deleted to free space. Its clips stay;
-- finding highlights and making clips again need the video.
-- AlterTable
ALTER TABLE "ClipProject" ADD COLUMN     "sourceDeletedAt" TIMESTAMP(3);
