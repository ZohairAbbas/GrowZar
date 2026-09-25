-- CreateEnum
CREATE TYPE "CustomerIdentityKind" AS ENUM ('PHONE', 'EMAIL', 'SHOPIFY_ID');

-- CreateTable
CREATE TABLE "customers" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "displayName" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mergedIntoId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_identities" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "kind" "CustomerIdentityKind" NOT NULL,
    "value" TEXT NOT NULL,
    "raw" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_identities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customers_storeId_lastSeenAt_idx" ON "customers"("storeId", "lastSeenAt");

-- CreateIndex
CREATE INDEX "customers_mergedIntoId_idx" ON "customers"("mergedIntoId");

-- CreateIndex
CREATE INDEX "customer_identities_customerId_idx" ON "customer_identities"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "customer_identities_storeId_kind_value_key" ON "customer_identities"("storeId", "kind", "value");

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_identities" ADD CONSTRAINT "customer_identities_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
