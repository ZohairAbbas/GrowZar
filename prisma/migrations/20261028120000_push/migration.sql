-- Push notifications from the installed app (pre-Wave-1 pack 4).
-- CreateTable
CREATE TABLE "push_subscriptions" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSuccessAt" TIMESTAMP(3),
    "failures" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "push_sends" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "storeId" TEXT,
    "insightId" TEXT,
    "mode" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "delivered" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "clickedAt" TIMESTAMP(3),
    CONSTRAINT "push_sends_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE UNIQUE INDEX "push_subscriptions_endpoint_key" ON "push_subscriptions"("endpoint");
-- CreateIndex
CREATE INDEX "push_subscriptions_memberId_idx" ON "push_subscriptions"("memberId");
-- CreateIndex
CREATE UNIQUE INDEX "push_sends_dedupeKey_key" ON "push_sends"("dedupeKey");
-- CreateIndex
CREATE INDEX "push_sends_memberId_day_idx" ON "push_sends"("memberId", "day");
-- CreateIndex
CREATE INDEX "push_sends_organizationId_createdAt_idx" ON "push_sends"("organizationId", "createdAt");
-- AddForeignKey
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "member"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "push_sends" ADD CONSTRAINT "push_sends_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
