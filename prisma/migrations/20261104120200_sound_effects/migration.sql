-- Sound effects in clips: a clip project's automatic sounds (a sound effect id each, null for off), a clip's own
-- sounds, its jump cuts once tightened, and the sounds a re-render from the Sounds tab mixes in.
-- AlterTable
ALTER TABLE "ClipProject" ADD COLUMN     "sfxCaptions" TEXT,
ADD COLUMN     "sfxCuts" TEXT,
ADD COLUMN     "sfxHook" TEXT;

-- AlterTable
ALTER TABLE "Clip" ADD COLUMN     "cuts" JSONB,
ADD COLUMN     "recaptionSounds" JSONB,
ADD COLUMN     "sounds" JSONB;
