-- A pause Meta's rate limit asked for, kept apart from the pause the owner chose (pausedUntil).
ALTER TABLE "IgAccount" ADD COLUMN "rateLimitedUntil" TIMESTAMP(3);
