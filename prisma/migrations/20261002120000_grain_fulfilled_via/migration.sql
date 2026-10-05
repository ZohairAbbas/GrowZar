-- G-GZR3-2: who booked the order's deciding parcel (Courierify's
-- `fulfilledVia`). Additive. Fills on the grain rebuild after worker start.
-- AlterTable
ALTER TABLE "order_grain" ADD COLUMN     "fulfilledVia" TEXT;
