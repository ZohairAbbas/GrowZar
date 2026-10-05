-- G-GZR3-3: the insight inbox and its events. Additive: two new tables.
-- CreateTable
CREATE TABLE "insights" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "detector" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "snoozedUntil" TIMESTAMP(3),
    "dismissedReason" TEXT,
    "dismissedNote" TEXT,
    "actedByUserId" TEXT,
    "actedAt" TIMESTAMP(3),
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "lastEvidence" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "insights_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insight_events" (
    "id" TEXT NOT NULL,
    "insightId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "userId" TEXT,
    "periodDays" INTEGER,
    "day" TEXT,
    "detail" JSONB,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "insight_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "insights_storeId_status_idx" ON "insights"("storeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "insights_storeId_fingerprint_key" ON "insights"("storeId", "fingerprint");

-- CreateIndex
CREATE INDEX "insight_events_storeId_at_idx" ON "insight_events"("storeId", "at");

-- CreateIndex
CREATE UNIQUE INDEX "insight_events_insightId_kind_userId_day_key" ON "insight_events"("insightId", "kind", "userId", "day");

-- AddForeignKey
ALTER TABLE "insights" ADD CONSTRAINT "insights_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insight_events" ADD CONSTRAINT "insight_events_insightId_fkey" FOREIGN KEY ("insightId") REFERENCES "insights"("id") ON DELETE CASCADE ON UPDATE CASCADE;

