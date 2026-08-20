-- CreateTable
CREATE TABLE "PresentationSetting" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "showroomVisible" BOOLEAN NOT NULL DEFAULT true,
    "showroomSort" INTEGER NOT NULL DEFAULT 0,
    "showroomFeatured" BOOLEAN NOT NULL DEFAULT false,
    "catalogIncluded" BOOLEAN NOT NULL DEFAULT true,
    "catalogSort" INTEGER NOT NULL DEFAULT 0,
    "catalogFeatured" BOOLEAN NOT NULL DEFAULT false,
    "catalogHero" BOOLEAN NOT NULL DEFAULT false,
    "coverImage" TEXT,
    "displayName" TEXT,
    "displayDesc" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PresentationSetting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PresentationSetting_entityType_entityId_key" ON "PresentationSetting"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "PresentationSetting_entityType_idx" ON "PresentationSetting"("entityType");
