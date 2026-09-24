-- CreateEnum
CREATE TYPE "SyncEntity" AS ENUM ('ORDER', 'PARCEL', 'SETTLEMENT', 'COST');

-- CreateEnum
CREATE TYPE "SyncRunStatus" AS ENUM ('IDLE', 'RUNNING', 'FAILED');

-- CreateTable
CREATE TABLE "sync_state" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "app" "SuiteApp" NOT NULL,
    "entity" "SyncEntity" NOT NULL,
    "cursor" TEXT,
    "updatedSince" TIMESTAMP(3),
    "status" "SyncRunStatus" NOT NULL DEFAULT 'IDLE',
    "runStartedAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "lastError" TEXT,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "rowsWritten" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sync_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "raw_records" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "app" "SuiteApp" NOT NULL,
    "entity" "SyncEntity" NOT NULL,
    "externalId" TEXT NOT NULL,
    "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
    "payload" JSONB NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "raw_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_snapshots" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "isFinal" BOOLEAN NOT NULL DEFAULT false,
    "contentHash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "supersededAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sync_state_status_idx" ON "sync_state"("status");

-- CreateIndex
CREATE UNIQUE INDEX "sync_state_storeId_app_entity_key" ON "sync_state"("storeId", "app", "entity");

-- CreateIndex
CREATE INDEX "raw_records_storeId_entity_sourceUpdatedAt_idx" ON "raw_records"("storeId", "entity", "sourceUpdatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "raw_records_storeId_app_entity_externalId_key" ON "raw_records"("storeId", "app", "entity", "externalId");

-- CreateIndex
CREATE INDEX "order_snapshots_storeId_orderId_supersededAt_idx" ON "order_snapshots"("storeId", "orderId", "supersededAt");

-- CreateIndex
CREATE UNIQUE INDEX "order_snapshots_storeId_orderId_version_key" ON "order_snapshots"("storeId", "orderId", "version");

-- AddForeignKey
ALTER TABLE "sync_state" ADD CONSTRAINT "sync_state_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raw_records" ADD CONSTRAINT "raw_records_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_snapshots" ADD CONSTRAINT "order_snapshots_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;
