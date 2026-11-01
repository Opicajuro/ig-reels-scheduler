-- The whisper.cpp build the worker transcribes with (Vulkan on the graphics, or the processor), shown on /settings.
CREATE TYPE "Transcriber" AS ENUM ('vulkan', 'cpu');

ALTER TABLE "VideoEncoding" ADD COLUMN "transcriber" "Transcriber",
ADD COLUMN "transcriberDevice" TEXT;
