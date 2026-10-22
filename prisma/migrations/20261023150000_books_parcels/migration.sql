-- The parcel register and couriers' settlement files and loadsheets (B5b), ported from
-- Financify's books_parcel_register + books_courier_sheets (0cc8732), with the store (D-65).
-- CreateTable
CREATE TABLE "bk_parcels" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderName" TEXT NOT NULL,
    "storeId" TEXT,
    "placedDay" DATE NOT NULL,
    "accountId" TEXT NOT NULL,
    "saleOwed" BIGINT NOT NULL DEFAULT 0,
    "owed" BIGINT NOT NULL DEFAULT 0,
    "shipped" BOOLEAN,
    "courier" TEXT,
    "trackingNumber" TEXT,
    "trackingStatus" TEXT,
    "trackingAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "bookedFees" BIGINT,
    "codAmount" BIGINT,
    "settlementRef" TEXT,
    "settledAt" TIMESTAMP(3),
    "settledNet" BIGINT,
    "settledFees" BIGINT,
    "payoutDocId" TEXT,
    "paid" BIGINT NOT NULL DEFAULT 0,
    "writeoffDocId" TEXT,
    "writtenOff" BIGINT NOT NULL DEFAULT 0,
    "damagedDocId" TEXT,
    "damaged" BIGINT NOT NULL DEFAULT 0,
    "checkedAt" TIMESTAMP(3),
    "settledStatus" TEXT,
    "loadsheetId" TEXT,
    "dispatchedOn" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bk_parcels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bk_courier_sheets" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "courier" TEXT NOT NULL,
    "ref" TEXT NOT NULL DEFAULT '',
    "date" DATE NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'file',
    "fileName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "totals" JSONB NOT NULL DEFAULT '{}',
    "documentId" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bk_courier_sheets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bk_courier_sheet_lines" (
    "id" BIGSERIAL NOT NULL,
    "sheetId" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "row" INTEGER NOT NULL,
    "tracking" TEXT,
    "orderRef" TEXT,
    "parcelId" TEXT,
    "status" TEXT NOT NULL,
    "rawStatus" TEXT,
    "cod" BIGINT NOT NULL DEFAULT 0,
    "collected" BIGINT NOT NULL DEFAULT 0,
    "delivery" BIGINT NOT NULL DEFAULT 0,
    "returnFee" BIGINT NOT NULL DEFAULT 0,
    "salesTax" BIGINT NOT NULL DEFAULT 0,
    "withheld" BIGINT NOT NULL DEFAULT 0,
    "otherFees" BIGINT NOT NULL DEFAULT 0,
    "net" BIGINT NOT NULL DEFAULT 0,
    "note" TEXT,

    CONSTRAINT "bk_courier_sheet_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bk_parcels_bookId_courier_idx" ON "bk_parcels"("bookId", "courier");

-- CreateIndex
CREATE INDEX "bk_parcels_bookId_placedDay_idx" ON "bk_parcels"("bookId", "placedDay");

-- CreateIndex
CREATE INDEX "bk_parcels_bookId_settlementRef_idx" ON "bk_parcels"("bookId", "settlementRef");

-- CreateIndex
CREATE UNIQUE INDEX "bk_parcels_bookId_orderId_key" ON "bk_parcels"("bookId", "orderId");

-- CreateIndex
CREATE INDEX "bk_courier_sheets_bookId_kind_status_idx" ON "bk_courier_sheets"("bookId", "kind", "status");

-- CreateIndex
CREATE INDEX "bk_courier_sheets_bookId_courier_ref_idx" ON "bk_courier_sheets"("bookId", "courier", "ref");

-- CreateIndex
CREATE INDEX "bk_courier_sheet_lines_sheetId_idx" ON "bk_courier_sheet_lines"("sheetId");

-- CreateIndex
CREATE INDEX "bk_courier_sheet_lines_bookId_tracking_idx" ON "bk_courier_sheet_lines"("bookId", "tracking");

-- CreateIndex
CREATE INDEX "bk_courier_sheet_lines_bookId_parcelId_idx" ON "bk_courier_sheet_lines"("bookId", "parcelId");

-- AddForeignKey
ALTER TABLE "bk_parcels" ADD CONSTRAINT "bk_parcels_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "bk_books"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bk_courier_sheets" ADD CONSTRAINT "bk_courier_sheets_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "bk_books"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bk_courier_sheet_lines" ADD CONSTRAINT "bk_courier_sheet_lines_sheetId_fkey" FOREIGN KEY ("sheetId") REFERENCES "bk_courier_sheets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

