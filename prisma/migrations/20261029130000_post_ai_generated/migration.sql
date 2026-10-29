-- Whether a post carries Instagram's AI info label (is_ai_generated on the media container).
ALTER TABLE "Post" ADD COLUMN "aiGenerated" BOOLEAN NOT NULL DEFAULT false;
