-- Caption fonts, highlight colours and emoji, a hook title, a progress bar and an end card. All are off or as before
-- by default, so existing projects make clips that look the same.
ALTER TABLE "ClipProject" ADD COLUMN "captionFont" TEXT NOT NULL DEFAULT 'default',
ADD COLUMN "captionHighlight" TEXT NOT NULL DEFAULT 'yellow',
ADD COLUMN "captionEmoji" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "hookMode" TEXT NOT NULL DEFAULT 'off',
ADD COLUMN "hookText" TEXT,
ADD COLUMN "progressBar" TEXT,
ADD COLUMN "endCardText" TEXT;
