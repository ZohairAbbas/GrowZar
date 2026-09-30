-- G-GZR2-3: courier and canonical city on the order grain; Financify ad spend.
-- Additive. The grain columns fill on the next rebuild.
-- AlterTable
ALTER TABLE "order_grain" ADD COLUMN     "city" TEXT,
ADD COLUMN     "cityRaw" TEXT,
ADD COLUMN     "courier" TEXT;

-- CreateTable
CREATE TABLE "ad_spend" (
    "storeId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "platform" TEXT,
    "spendAmount" DECIMAL(18,6) NOT NULL,
    "feesAmount" DECIMAL(18,6) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "method" TEXT NOT NULL,
    "fxStatus" TEXT,
    "detail" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ad_spend_pkey" PRIMARY KEY ("storeId","day","level","key")
);

-- AddForeignKey
ALTER TABLE "ad_spend" ADD CONSTRAINT "ad_spend_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

