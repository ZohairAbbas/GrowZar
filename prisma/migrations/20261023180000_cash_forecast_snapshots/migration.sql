-- Each week's cash forecast, kept for Plan's forecast-against-actual (B7, D-94).
-- CreateTable
CREATE TABLE "cash_forecast_snapshots" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "week" DATE NOT NULL,
    "asOf" TIMESTAMP(3) NOT NULL,
    "forecast" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "cash_forecast_snapshots_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE UNIQUE INDEX "cash_forecast_snapshots_storeId_week_key" ON "cash_forecast_snapshots"("storeId", "week");
-- AddForeignKey
ALTER TABLE "cash_forecast_snapshots" ADD CONSTRAINT "cash_forecast_snapshots_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;
