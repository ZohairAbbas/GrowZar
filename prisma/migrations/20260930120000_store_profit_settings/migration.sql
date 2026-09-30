-- G-GZR2-4: each store's Financify profit settings (rule #15). Additive.
-- CreateTable
CREATE TABLE "store_profit_settings" (
    "storeId" TEXT NOT NULL,
    "settingsHash" TEXT NOT NULL,
    "settings" JSONB NOT NULL,
    "isDefault" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "store_profit_settings_pkey" PRIMARY KEY ("storeId")
);

-- AddForeignKey
ALTER TABLE "store_profit_settings" ADD CONSTRAINT "store_profit_settings_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

