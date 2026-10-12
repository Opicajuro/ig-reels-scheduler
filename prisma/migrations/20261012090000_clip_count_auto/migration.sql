-- A null clip count means Auto, so projects get no default count any more. Existing counts are kept.
ALTER TABLE "ClipProject" ALTER COLUMN "clipCount" DROP NOT NULL,
ALTER COLUMN "clipCount" DROP DEFAULT;
