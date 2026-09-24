-- CreateEnum
CREATE TYPE "InboundEventStatus" AS ENUM ('PENDING', 'PROCESSED', 'SUPERSEDED', 'IGNORED', 'FAILED');

-- CreateTable
CREATE TABLE "inbound_events" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "app" "SuiteApp" NOT NULL,
    "topic" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "storeId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "entityKey" TEXT,
    "actor" JSONB,
    "payload" JSONB NOT NULL,
    "status" "InboundEventStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "inbound_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "inbound_events_eventId_key" ON "inbound_events"("eventId");

-- CreateIndex
CREATE INDEX "inbound_events_storeId_receivedAt_idx" ON "inbound_events"("storeId", "receivedAt");

-- CreateIndex
CREATE INDEX "inbound_events_status_idx" ON "inbound_events"("status");

-- CreateIndex
CREATE INDEX "inbound_events_storeId_entityKey_occurredAt_idx" ON "inbound_events"("storeId", "entityKey", "occurredAt");

-- AddForeignKey
ALTER TABLE "inbound_events" ADD CONSTRAINT "inbound_events_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;
