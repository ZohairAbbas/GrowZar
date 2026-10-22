-- Banking for Books (B5a): statement imports and lines, bank rules, reconciliations and
-- group matches, ported from Financify's books_bank + books_bank_matching (0cc8732).
-- Statement files are never stored; descriptions arrive masked (D-72).
-- CreateTable
CREATE TABLE "bk_statement_imports" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "fileName" TEXT,
    "added" INTEGER NOT NULL,
    "duplicates" INTEGER NOT NULL,
    "firstDate" DATE,
    "lastDate" DATE,
    "balanceNote" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bk_statement_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bk_statement_lines" (
    "id" BIGSERIAL NOT NULL,
    "bookId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "importId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "description" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "balance" BIGINT,
    "key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "entryLineId" BIGINT,
    "documentId" TEXT,
    "matchGroup" TEXT,
    "dupOfId" BIGINT,
    "matchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bk_statement_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bk_bank_rules" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "contains" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "contactId" TEXT,
    "minAmount" BIGINT,
    "maxAmount" BIGINT,
    "kind" TEXT NOT NULL DEFAULT 'account',
    "split" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bk_bank_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bk_reconciliations" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "statementDate" DATE NOT NULL,
    "statementBalance" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "bk_reconciliations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bk_cleared_lines" (
    "entryLineId" BIGINT NOT NULL,
    "bookId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "reconciliationId" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bk_cleared_lines_pkey" PRIMARY KEY ("entryLineId")
);

-- CreateTable
CREATE TABLE "bk_statement_matches" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "entryLineId" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bk_statement_matches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bk_statement_imports_bookId_accountId_idx" ON "bk_statement_imports"("bookId", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "bk_statement_lines_entryLineId_key" ON "bk_statement_lines"("entryLineId");

-- CreateIndex
CREATE INDEX "bk_statement_lines_bookId_matchGroup_idx" ON "bk_statement_lines"("bookId", "matchGroup");

-- CreateIndex
CREATE INDEX "bk_statement_lines_bookId_accountId_status_date_idx" ON "bk_statement_lines"("bookId", "accountId", "status", "date");

-- CreateIndex
CREATE UNIQUE INDEX "bk_statement_lines_bookId_accountId_key_key" ON "bk_statement_lines"("bookId", "accountId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "bk_bank_rules_bookId_direction_contains_key" ON "bk_bank_rules"("bookId", "direction", "contains");

-- CreateIndex
CREATE INDEX "bk_reconciliations_bookId_accountId_status_idx" ON "bk_reconciliations"("bookId", "accountId", "status");

-- CreateIndex
CREATE INDEX "bk_cleared_lines_reconciliationId_idx" ON "bk_cleared_lines"("reconciliationId");

-- CreateIndex
CREATE INDEX "bk_cleared_lines_bookId_accountId_idx" ON "bk_cleared_lines"("bookId", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "bk_statement_matches_entryLineId_key" ON "bk_statement_matches"("entryLineId");

-- CreateIndex
CREATE INDEX "bk_statement_matches_bookId_groupId_idx" ON "bk_statement_matches"("bookId", "groupId");

-- AddForeignKey
ALTER TABLE "bk_statement_imports" ADD CONSTRAINT "bk_statement_imports_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "bk_books"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bk_statement_lines" ADD CONSTRAINT "bk_statement_lines_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "bk_books"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bk_statement_lines" ADD CONSTRAINT "bk_statement_lines_importId_fkey" FOREIGN KEY ("importId") REFERENCES "bk_statement_imports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bk_bank_rules" ADD CONSTRAINT "bk_bank_rules_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "bk_books"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bk_reconciliations" ADD CONSTRAINT "bk_reconciliations_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "bk_books"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bk_cleared_lines" ADD CONSTRAINT "bk_cleared_lines_reconciliationId_fkey" FOREIGN KEY ("reconciliationId") REFERENCES "bk_reconciliations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bk_statement_matches" ADD CONSTRAINT "bk_statement_matches_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "bk_books"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- One open reconciliation per account (Financify's partial unique index).
CREATE UNIQUE INDEX "bk_reconciliations_one_open" ON "bk_reconciliations"("bookId", "accountId") WHERE status = 'open';
