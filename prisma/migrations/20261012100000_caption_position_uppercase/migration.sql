-- Caption position (bottom, middle or top) and all capitals, for every project. Existing projects keep the defaults.
ALTER TABLE "ClipProject" ADD COLUMN "captionPosition" TEXT NOT NULL DEFAULT 'bottom',
ADD COLUMN "captionUppercase" BOOLEAN NOT NULL DEFAULT false;
