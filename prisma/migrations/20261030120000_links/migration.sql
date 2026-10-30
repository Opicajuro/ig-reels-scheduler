-- Links to other platforms: where each clip was posted elsewhere, the owner's own profiles, and video guides for the
-- Help page. Media remembers the clip it was scheduled from, so a post can show that clip's links.
ALTER TABLE "Media" ADD COLUMN "sourceClipId" TEXT;

CREATE TABLE "ClipLink" (
    "id" TEXT NOT NULL,
    "clipId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClipLink_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProfileLink" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProfileLink_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GuideLink" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GuideLink_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ClipLink" ADD CONSTRAINT "ClipLink_clipId_fkey" FOREIGN KEY ("clipId") REFERENCES "Clip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProfileLink" ADD CONSTRAINT "ProfileLink_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "GuideLink" ADD CONSTRAINT "GuideLink_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
