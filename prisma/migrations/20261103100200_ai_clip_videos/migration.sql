-- AI intros and B-roll made from an existing clip: the job's kind, the clip it starts from, and the moment in it.
CREATE TYPE "AiVideoKind" AS ENUM ('prompt', 'intro', 'broll');

ALTER TABLE "AiVideoJob" ADD COLUMN "kind" "AiVideoKind" NOT NULL DEFAULT 'prompt',
ADD COLUMN "sourceClipId" TEXT,
ADD COLUMN "at" DOUBLE PRECISION;

ALTER TABLE "AiVideoJob" ADD CONSTRAINT "AiVideoJob_sourceClipId_fkey" FOREIGN KEY ("sourceClipId") REFERENCES "Clip"("id") ON DELETE SET NULL ON UPDATE CASCADE;
