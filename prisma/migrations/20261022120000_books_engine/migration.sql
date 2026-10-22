-- Books engine (B1, D-62/D-63): ported from Financify's Books migrations at
-- 0cc8732 (books_m1, books_connectors, books_allocations, books_phase_b,
-- books_tax, books_accounts_tags, books_currencies), folded into one.
-- Changes from Financify:
-- * one book per organization (D-65): "organizationId" replaces "shopDomain".
--   No foreign key to organizations or stores: books outlive an uninstall and
--   are deleted only on the organization's request (D-71).
-- * "storeId" on documents and entry lines, null for organization-level items
--   such as rent, with an index for per-store reports.
-- * no stock items table: the stock check comes later (D-88).

-- CreateTable
CREATE TABLE "bk_books" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "currencyDecimals" INTEGER NOT NULL DEFAULT 2,
    "fiscalYearStartMonth" INTEGER NOT NULL DEFAULT 7,
    "lockedThrough" DATE,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bk_books_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bk_accounts" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "subtype" TEXT NOT NULL DEFAULT 'other',
    "systemKey" TEXT,
    "parentId" TEXT,
    "currency" VARCHAR(3),
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bk_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bk_contacts" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kinds" TEXT[],
    "email" TEXT,
    "phone" TEXT,
    "notes" TEXT,
    "lastAccountId" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bk_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bk_documents" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "number" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "date" DATE NOT NULL,
    "contactId" TEXT,
    "data" JSONB NOT NULL,
    "total" BIGINT NOT NULL DEFAULT 0,
    "memo" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "sourceRef" TEXT,
    "storeId" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdBy" TEXT,
    "postedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bk_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bk_sequences" (
    "bookId" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "next" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "bk_sequences_pkey" PRIMARY KEY ("bookId","prefix")
);

-- CreateTable
CREATE TABLE "bk_entries" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bk_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bk_entry_lines" (
    "id" BIGSERIAL NOT NULL,
    "entryId" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "contactId" TEXT,
    "storeId" TEXT,
    "amount" BIGINT NOT NULL,
    "fxAmount" BIGINT,
    "date" DATE NOT NULL,
    "description" TEXT,

    CONSTRAINT "bk_entry_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bk_audit_events" (
    "id" BIGSERIAL NOT NULL,
    "bookId" TEXT NOT NULL,
    "actor" TEXT,
    "action" TEXT NOT NULL,
    "documentId" TEXT,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bk_audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "bk_books_organizationId_key" ON "bk_books"("organizationId");

-- CreateIndex
CREATE INDEX "bk_accounts_bookId_type_idx" ON "bk_accounts"("bookId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "bk_accounts_bookId_code_key" ON "bk_accounts"("bookId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "bk_accounts_bookId_systemKey_key" ON "bk_accounts"("bookId", "systemKey");

-- CreateIndex
CREATE INDEX "bk_contacts_bookId_name_idx" ON "bk_contacts"("bookId", "name");

-- CreateIndex
CREATE INDEX "bk_documents_bookId_status_date_idx" ON "bk_documents"("bookId", "status", "date");

-- CreateIndex
CREATE INDEX "bk_documents_bookId_type_date_idx" ON "bk_documents"("bookId", "type", "date");

-- CreateIndex
CREATE INDEX "bk_documents_bookId_contactId_idx" ON "bk_documents"("bookId", "contactId");

-- CreateIndex
CREATE UNIQUE INDEX "bk_documents_bookId_source_sourceRef_key" ON "bk_documents"("bookId", "source", "sourceRef");

-- CreateIndex
CREATE UNIQUE INDEX "bk_documents_bookId_number_key" ON "bk_documents"("bookId", "number");

-- CreateIndex
CREATE INDEX "bk_entries_bookId_date_idx" ON "bk_entries"("bookId", "date");

-- CreateIndex
CREATE INDEX "bk_entries_documentId_idx" ON "bk_entries"("documentId");

-- CreateIndex
CREATE INDEX "bk_entry_lines_bookId_accountId_date_idx" ON "bk_entry_lines"("bookId", "accountId", "date");

-- CreateIndex
CREATE INDEX "bk_entry_lines_bookId_storeId_accountId_date_idx" ON "bk_entry_lines"("bookId", "storeId", "accountId", "date");

-- CreateIndex
CREATE INDEX "bk_documents_tags_idx" ON "bk_documents" USING GIN ("tags");

-- CreateIndex
CREATE INDEX "bk_entry_lines_bookId_contactId_idx" ON "bk_entry_lines"("bookId", "contactId");

-- CreateIndex
CREATE INDEX "bk_entry_lines_entryId_idx" ON "bk_entry_lines"("entryId");

-- CreateIndex
CREATE INDEX "bk_audit_events_bookId_createdAt_idx" ON "bk_audit_events"("bookId", "createdAt");

-- CreateIndex
CREATE INDEX "bk_audit_events_documentId_idx" ON "bk_audit_events"("documentId");

-- AddForeignKey
ALTER TABLE "bk_accounts" ADD CONSTRAINT "bk_accounts_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "bk_books"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bk_contacts" ADD CONSTRAINT "bk_contacts_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "bk_books"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bk_documents" ADD CONSTRAINT "bk_documents_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "bk_books"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bk_entries" ADD CONSTRAINT "bk_entries_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "bk_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bk_entry_lines" ADD CONSTRAINT "bk_entry_lines_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "bk_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- Books ledger guarantees (not expressible in Prisma).
-- 1. Posted history is permanent: entries, entry lines and audit events reject
--    UPDATE and DELETE. The only exception is a shop purge (GDPR shop/redact),
--    which sets `books.allow_purge = 'on'` for its own transaction.
-- 2. Every entry balances: a deferred constraint trigger checks at COMMIT that
--    the lines of each touched entry sum to zero and that there are at least two.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION bk_reject_change() RETURNS trigger AS $$
BEGIN
  IF current_setting('books.allow_purge', true) = 'on' THEN
    RETURN COALESCE(OLD, NEW);
  END IF;
  RAISE EXCEPTION 'Books: % on % is not allowed; posted history is permanent (cancel the document instead)', TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER bk_entries_immutable BEFORE UPDATE OR DELETE ON "bk_entries"
  FOR EACH ROW EXECUTE FUNCTION bk_reject_change();
CREATE TRIGGER bk_entry_lines_immutable BEFORE UPDATE OR DELETE ON "bk_entry_lines"
  FOR EACH ROW EXECUTE FUNCTION bk_reject_change();
CREATE TRIGGER bk_audit_events_immutable BEFORE UPDATE OR DELETE ON "bk_audit_events"
  FOR EACH ROW EXECUTE FUNCTION bk_reject_change();

CREATE OR REPLACE FUNCTION bk_check_entry_balanced() RETURNS trigger AS $$
DECLARE
  total BIGINT;
  n INTEGER;
BEGIN
  SELECT COALESCE(SUM(amount), 0), COUNT(*) INTO total, n
    FROM "bk_entry_lines" WHERE "entryId" = NEW."entryId";
  IF total <> 0 THEN
    RAISE EXCEPTION 'Books: entry % does not balance (off by %)', NEW."entryId", total;
  END IF;
  IF n < 2 THEN
    RAISE EXCEPTION 'Books: entry % has fewer than two lines', NEW."entryId";
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER bk_entry_lines_balanced AFTER INSERT ON "bk_entry_lines"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION bk_check_entry_balanced();

-- CreateTable
CREATE TABLE "bk_connectors" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "mode" TEXT NOT NULL DEFAULT 'draft',
    "startDate" DATE,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "syncedThrough" DATE,
    "runningSince" TIMESTAMP(3),
    "lastRunAt" TIMESTAMP(3),
    "lastStatus" TEXT,
    "lastMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bk_connectors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bk_connector_runs" (
    "id" TEXT NOT NULL,
    "connectorId" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "fromDate" DATE,
    "toDate" DATE,
    "created" INTEGER NOT NULL DEFAULT 0,
    "updated" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "message" TEXT,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "bk_connector_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "bk_connectors_bookId_key_key" ON "bk_connectors"("bookId", "key");

-- CreateIndex
CREATE INDEX "bk_connector_runs_connectorId_startedAt_idx" ON "bk_connector_runs"("connectorId", "startedAt");

-- AddForeignKey
ALTER TABLE "bk_connectors" ADD CONSTRAINT "bk_connectors_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "bk_books"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bk_connector_runs" ADD CONSTRAINT "bk_connector_runs_connectorId_fkey" FOREIGN KEY ("connectorId") REFERENCES "bk_connectors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "bk_allocations" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "billId" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "voidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bk_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bk_allocations_bookId_billId_idx" ON "bk_allocations"("bookId", "billId");

-- CreateIndex
CREATE INDEX "bk_allocations_paymentId_idx" ON "bk_allocations"("paymentId");

-- Books: nothing may be written to the ledger on or before the date the books
-- are closed through. The app checks first (with a share lock on the book);
-- this is the backstop.
CREATE OR REPLACE FUNCTION bk_check_open_period() RETURNS trigger AS $$
DECLARE
  closed date;
BEGIN
  SELECT "lockedThrough" INTO closed FROM "bk_books" WHERE id = NEW."bookId";
  IF closed IS NOT NULL AND NEW.date <= closed THEN
    RAISE EXCEPTION 'Books are closed through %', closed USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER bk_entry_lines_open_period BEFORE INSERT ON "bk_entry_lines"
  FOR EACH ROW EXECUTE FUNCTION bk_check_open_period();

-- Books: tax rates (sales tax, claimable purchase tax, withholding).
-- CreateTable
CREATE TABLE "bk_tax_rates" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "rateBp" INTEGER NOT NULL,
    "accountId" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bk_tax_rates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "bk_tax_rates_bookId_name_key" ON "bk_tax_rates"("bookId", "name");

-- AddForeignKey
ALTER TABLE "bk_tax_rates" ADD CONSTRAINT "bk_tax_rates_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "bk_books"("id") ON DELETE CASCADE ON UPDATE CASCADE;
