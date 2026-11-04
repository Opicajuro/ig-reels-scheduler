-- "Write with AI" on a clip: the script writer's job id and step while it writes, the title, description and hashtags
-- it suggested until they are used or discarded, and why the last one failed.
-- AlterTable
ALTER TABLE "Clip" ADD COLUMN     "aiSuggestion" JSONB,
ADD COLUMN     "aiWriteError" TEXT,
ADD COLUMN     "aiWriteId" TEXT,
ADD COLUMN     "aiWriteStep" TEXT;
