-- The organization's Books switch (B2, D-91): off by default.
-- CreateTable
CREATE TABLE "books_settings" (
    "organizationId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "changedByUserId" TEXT,
    "changedAt" TIMESTAMP(3),

    CONSTRAINT "books_settings_pkey" PRIMARY KEY ("organizationId")
);

-- AddForeignKey
ALTER TABLE "books_settings" ADD CONSTRAINT "books_settings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

