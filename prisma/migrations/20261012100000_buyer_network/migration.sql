-- Courierify's buyer network answers per buyer (Phase 5, G-GZR5-16; D-53, D-54).
-- CreateTable
CREATE TABLE "buyer_network" (
    "storeId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "storeFigures" JSONB,
    "network" JSONB,
    "otherStores" INTEGER,
    "riskLevel" TEXT,
    "riskBasis" TEXT,
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "buyer_network_pkey" PRIMARY KEY ("storeId","customerId")
);
-- CreateIndex
CREATE INDEX "buyer_network_storeId_riskLevel_idx" ON "buyer_network"("storeId", "riskLevel");
-- AddForeignKey
ALTER TABLE "buyer_network" ADD CONSTRAINT "buyer_network_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;
