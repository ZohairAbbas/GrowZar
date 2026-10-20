-- Saved budget plans (G-GZR11-6).
-- CreateTable
CREATE TABLE "plans" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "asOf" TIMESTAMP(3) NOT NULL,
    "version" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "inputs" JSONB NOT NULL,
    "output" JSONB NOT NULL,
    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE INDEX "plans_storeId_createdAt_idx" ON "plans"("storeId", "createdAt");
-- AddForeignKey
ALTER TABLE "plans" ADD CONSTRAINT "plans_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;
