-- Courierify's label for each order's buyer as of the order (Phase 5, G-GZR5-17; G-CFY5-3).
-- CreateTable
CREATE TABLE "order_network" (
    "storeId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "riskLevel" TEXT,
    "otherStores" INTEGER,
    "networkOrders" INTEGER,
    "networkReturned" INTEGER,
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "order_network_pkey" PRIMARY KEY ("storeId","orderId")
);
-- AddForeignKey
ALTER TABLE "order_network" ADD CONSTRAINT "order_network_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;
