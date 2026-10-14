-- The weekly digest (G-GZR6-5): the organization switch, members' opt-outs, and the send log.
-- CreateTable
CREATE TABLE "digest_settings" (
    "organizationId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "changedByUserId" TEXT,
    "changedAt" TIMESTAMP(3),
    CONSTRAINT "digest_settings_pkey" PRIMARY KEY ("organizationId")
);
-- CreateTable
CREATE TABLE "digest_opt_outs" (
    "memberId" TEXT NOT NULL,
    "via" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "digest_opt_outs_pkey" PRIMARY KEY ("memberId")
);
-- CreateTable
CREATE TABLE "digest_sends" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'email',
    "mode" TEXT NOT NULL,
    "week" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "providerId" TEXT,
    "error" TEXT,
    "content" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    CONSTRAINT "digest_sends_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE UNIQUE INDEX "digest_sends_dedupeKey_key" ON "digest_sends"("dedupeKey");
-- CreateIndex
CREATE INDEX "digest_sends_organizationId_createdAt_idx" ON "digest_sends"("organizationId", "createdAt");
-- CreateIndex
CREATE INDEX "digest_sends_memberId_idx" ON "digest_sends"("memberId");
-- AddForeignKey
ALTER TABLE "digest_settings" ADD CONSTRAINT "digest_settings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "digest_opt_outs" ADD CONSTRAINT "digest_opt_outs_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "member"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "digest_sends" ADD CONSTRAINT "digest_sends_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
