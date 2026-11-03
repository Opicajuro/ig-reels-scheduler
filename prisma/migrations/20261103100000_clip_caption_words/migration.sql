-- A clip's own caption words and its cut without captions, so its captions can be edited and drawn again. Clips made
-- before this keep null: their words are not guessed from the project's transcript.
-- AlterTable
ALTER TABLE "Clip" ADD COLUMN     "baseKey" TEXT,
ADD COLUMN     "recaptionError" TEXT,
ADD COLUMN     "recaptionId" TEXT,
ADD COLUMN     "recaptionStep" TEXT,
ADD COLUMN     "recaptionWords" JSONB,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "words" JSONB;
