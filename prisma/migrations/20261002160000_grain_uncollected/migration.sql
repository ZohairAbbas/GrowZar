-- G-GZR3-5: COD of delivered parcels no settlement has covered yet. Additive.
-- AlterTable
ALTER TABLE "order_grain" ADD COLUMN     "uncollectedAmount" DECIMAL(18,6),
ADD COLUMN     "uncollectedCurrency" CHAR(3);

