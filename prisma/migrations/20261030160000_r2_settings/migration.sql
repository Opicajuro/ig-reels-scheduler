-- Cloudflare R2, where a post's video is put for Instagram to download. The secret access key is stored sealed.
ALTER TABLE "Setting" ADD COLUMN "r2AccountId" TEXT,
ADD COLUMN "r2AccessKeyId" TEXT,
ADD COLUMN "r2SecretAccessKey" TEXT,
ADD COLUMN "r2Bucket" TEXT;
