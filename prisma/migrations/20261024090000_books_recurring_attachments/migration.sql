-- Books v1.1 V6: recurring entries and attachments (ported from Financify's two migrations).
-- CreateTable
CREATE TABLE "bk_recurring" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "contactId" TEXT,
    "memo" TEXT,
    "data" JSONB NOT NULL,
    "storeId" TEXT,
    "dueDays" INTEGER,
    "frequency" TEXT NOT NULL,
    "interval" INTEGER NOT NULL DEFAULT 1,
    "dayOfMonth" INTEGER,
    "startDate" DATE NOT NULL,
    "endDate" DATE,
    "nextDate" DATE,
    "mode" TEXT NOT NULL DEFAULT 'draft',
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "lastRunAt" TIMESTAMP(3),
    "lastMessage" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bk_recurring_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bk_attachments" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bk_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bk_recurring_bookId_idx" ON "bk_recurring"("bookId");
CREATE INDEX "bk_recurring_nextDate_idx" ON "bk_recurring"("nextDate");
CREATE INDEX "bk_attachments_documentId_idx" ON "bk_attachments"("documentId");
CREATE INDEX "bk_attachments_bookId_idx" ON "bk_attachments"("bookId");

-- AddForeignKey
ALTER TABLE "bk_recurring" ADD CONSTRAINT "bk_recurring_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "bk_books"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bk_attachments" ADD CONSTRAINT "bk_attachments_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "bk_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
