-- G-GZR2-2: the order grain. Derived from synced rows; safe to drop and rebuild.
-- CreateTable
CREATE TABLE "order_grain" (
    "storeId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderName" TEXT,
    "createdAt" TIMESTAMP(3),
    "localDay" TEXT,
    "currency" CHAR(3),
    "placedAmount" DECIMAL(18,6),
    "deliveredAmount" DECIMAL(18,6),
    "refundedAmount" DECIMAL(18,6),
    "discountsAmount" DECIMAL(18,6),
    "shippingAmount" DECIMAL(18,6),
    "taxAmount" DECIMAL(18,6),
    "collectedAmount" DECIMAL(18,6),
    "collectedCurrency" CHAR(3),
    "cogsAmount" DECIMAL(18,6),
    "cogsCurrency" CHAR(3),
    "cogsComplete" BOOLEAN,
    "courierFeeAmount" DECIMAL(18,6),
    "courierFeeCurrency" CHAR(3),
    "courierFeeSource" TEXT,
    "outcome" TEXT NOT NULL,
    "outcomeAuthority" TEXT NOT NULL,
    "outcomeBasis" TEXT,
    "outcomeAt" TIMESTAMP(3),
    "orderCancelled" BOOLEAN NOT NULL,
    "shipmentCancelled" BOOLEAN NOT NULL,
    "confirmation" TEXT,
    "customerId" TEXT,
    "parcelCount" INTEGER NOT NULL,
    "lines" JSONB NOT NULL,
    "explain" JSONB NOT NULL,
    "builtAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_grain_pkey" PRIMARY KEY ("storeId","orderId")
);

-- CreateIndex
CREATE INDEX "order_grain_storeId_localDay_idx" ON "order_grain"("storeId", "localDay");

-- AddForeignKey
ALTER TABLE "order_grain" ADD CONSTRAINT "order_grain_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

