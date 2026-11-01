-- "Find highlights" picks the clips for the person to adjust on a timeline before "Make clips" renders them.
ALTER TYPE "ClipProjectStatus" ADD VALUE 'picking' BEFORE 'rendering';
ALTER TYPE "ClipProjectStatus" ADD VALUE 'review' BEFORE 'rendering';

ALTER TABLE "ClipProject" ADD COLUMN "highlights" JSONB,
ADD COLUMN "transcript" JSONB;

-- A reviewed highlight starts and ends on half seconds.
ALTER TABLE "Clip" ALTER COLUMN "start" SET DATA TYPE DOUBLE PRECISION,
ALTER COLUMN "length" SET DATA TYPE DOUBLE PRECISION;
