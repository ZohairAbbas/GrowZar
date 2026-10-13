-- Home's next-app prompts: shown and clicked (G-GZR6-3).
-- CreateTable
CREATE TABLE "app_prompt_events" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "app" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "userId" TEXT,
    "day" TEXT,
    "detail" JSONB,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "app_prompt_events_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE INDEX "app_prompt_events_storeId_app_idx" ON "app_prompt_events"("storeId", "app");
-- CreateIndex
CREATE UNIQUE INDEX "app_prompt_events_storeId_app_kind_userId_day_key" ON "app_prompt_events"("storeId", "app", "kind", "userId", "day");
-- AddForeignKey
ALTER TABLE "app_prompt_events" ADD CONSTRAINT "app_prompt_events_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;
