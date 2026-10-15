-- Outcome tracking (G-GZR9-1): one watch per click episode on an insight, and the full finding each evaluation saw.
-- AlterTable
ALTER TABLE "insights" ADD COLUMN     "lastFinding" JSONB;
-- CreateTable
CREATE TABLE "insight_outcomes" (
    "id" TEXT NOT NULL,
    "insightId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "detector" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "actedAt" TIMESTAMP(3) NOT NULL,
    "actedByUserId" TEXT,
    "internal" BOOLEAN NOT NULL DEFAULT false,
    "baseline" JSONB NOT NULL,
    "baselineSource" TEXT NOT NULL,
    "observed" JSONB,
    "checkpoints" JSONB NOT NULL DEFAULT '[]',
    "verdict" TEXT NOT NULL DEFAULT 'too_early',
    "effect" JSONB,
    "money" JSONB,
    "formulaVersion" INTEGER,
    "judgedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "closedReason" TEXT,
    "hiddenAt" TIMESTAMP(3),
    "hiddenByUserId" TEXT,
    "hiddenNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "insight_outcomes_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE INDEX "insight_outcomes_storeId_actedAt_idx" ON "insight_outcomes"("storeId", "actedAt");
-- CreateIndex
CREATE UNIQUE INDEX "insight_outcomes_insightId_actedAt_key" ON "insight_outcomes"("insightId", "actedAt");
-- AddForeignKey
ALTER TABLE "insight_outcomes" ADD CONSTRAINT "insight_outcomes_insightId_fkey" FOREIGN KEY ("insightId") REFERENCES "insights"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "insight_outcomes" ADD CONSTRAINT "insight_outcomes_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;
