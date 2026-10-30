-- The look of the app, chosen on /settings: a design, Night Spring's colour palette, and a colour shift in degrees.
ALTER TABLE "Setting" ADD COLUMN "design" TEXT NOT NULL DEFAULT 'night',
ADD COLUMN "palette" TEXT NOT NULL DEFAULT 'default',
ADD COLUMN "hue" INTEGER NOT NULL DEFAULT 0;
