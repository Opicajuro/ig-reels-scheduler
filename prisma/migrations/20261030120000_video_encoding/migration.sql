-- The H.264 encoder the worker found at its last start (one row), shown on /settings.
CREATE TYPE "VideoEncoder" AS ENUM ('nvenc', 'x264');

CREATE TABLE "VideoEncoding" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "encoder" "VideoEncoder" NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VideoEncoding_pkey" PRIMARY KEY ("id")
);
