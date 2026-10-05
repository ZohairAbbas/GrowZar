-- Financify's daily exchange rates (G-FIN2-1). Additive: one new table.
-- CreateTable
CREATE TABLE "fx_rates" (
    "base" CHAR(3) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "day" TEXT NOT NULL,
    "rate" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fx_rates_pkey" PRIMARY KEY ("base","currency","day")
);

