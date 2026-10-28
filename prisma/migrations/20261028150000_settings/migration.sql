-- The app's settings, edited on /settings, in one row. The Meta app secret and the Resend API key are stored sealed.
CREATE TABLE "Setting" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "metaAppId" TEXT,
    "metaAppSecret" TEXT,
    "alertEmail" TEXT,
    "resendApiKey" TEXT,
    "emailFrom" TEXT,
    "captionLanguage" TEXT NOT NULL DEFAULT 'auto',

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("id")
);
