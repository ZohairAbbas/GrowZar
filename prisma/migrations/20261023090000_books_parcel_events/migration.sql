-- Parcel events for Books' sales connector (B3c), ported from Financify's books_parcel_returns/register, with the store (D-65).
-- CreateTable
CREATE TABLE "bk_parcel_events" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "storeId" TEXT,
    "orderId" TEXT NOT NULL,
    "orderName" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "kind" TEXT NOT NULL,
    "lines" JSONB NOT NULL,
    "documentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bk_parcel_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bk_parcel_events_bookId_day_idx" ON "bk_parcel_events"("bookId", "day");

-- CreateIndex
CREATE UNIQUE INDEX "bk_parcel_events_bookId_orderId_day_kind_key" ON "bk_parcel_events"("bookId", "orderId", "day", "kind");

-- AddForeignKey
ALTER TABLE "bk_parcel_events" ADD CONSTRAINT "bk_parcel_events_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "bk_books"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bk_parcel_events" ADD CONSTRAINT "bk_parcel_events_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "bk_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

