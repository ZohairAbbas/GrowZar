-- G-GZR2-1: Courierify's shipment status event log, at event grain.
-- No data is copied here: the worker pulls it through the ordinary sync path.
-- AlterEnum
ALTER TYPE "SyncEntity" ADD VALUE 'SHIPMENT_EVENT';

-- CreateTable
CREATE TABLE "shipment_events" (
    "id" BIGSERIAL NOT NULL,
    "storeId" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "previousStatus" TEXT,
    "source" TEXT NOT NULL,
    "courierEventAt" TIMESTAMP(3),
    "observedAt" TIMESTAMP(3) NOT NULL,
    "raw" TEXT,
    "sourceEventId" BIGINT NOT NULL,
    "sourceCreatedAt" TIMESTAMP(3) NOT NULL,
    "ingestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "eventKey" TEXT NOT NULL,

    CONSTRAINT "shipment_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shipment_events_storeId_shipmentId_eventKey_key" ON "shipment_events"("storeId", "shipmentId", "eventKey");

-- AddForeignKey
ALTER TABLE "shipment_events" ADD CONSTRAINT "shipment_events_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

