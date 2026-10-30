-- Lets a render that was interrupted by sleep or by closing Localirs go on from the clips it finished.
ALTER TABLE "ClipProject" ADD COLUMN "renderId" TEXT,
ADD COLUMN "renderPlan" JSONB;

-- A project rendering now gets an id, so the worker can queue it again when it starts. It has no stored plan, so it
-- starts over.
UPDATE "ClipProject" SET "renderId" = gen_random_uuid()::text WHERE "status" = 'rendering';
