-- CreateEnum
CREATE TYPE "StoreAccessRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'DECLINED', 'CANCELLED');

-- CreateTable
CREATE TABLE "consumed_claim_tokens" (
    "id" TEXT NOT NULL,
    "jti" TEXT NOT NULL,
    "app" "SuiteApp" NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "userId" TEXT,
    "storeId" TEXT,
    "consumedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tokenExpiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "consumed_claim_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pending_claims" (
    "id" TEXT NOT NULL,
    "app" "SuiteApp" NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "shopifyUserId" TEXT,
    "isStoreOwner" BOOLEAN NOT NULL,
    "locale" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "pending_claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store_access_requests" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "requestedByUserId" TEXT NOT NULL,
    "app" "SuiteApp" NOT NULL,
    "claimsOwnership" BOOLEAN NOT NULL DEFAULT false,
    "status" "StoreAccessRequestStatus" NOT NULL DEFAULT 'PENDING',
    "decidedByUserId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "store_access_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "consumed_claim_tokens_jti_key" ON "consumed_claim_tokens"("jti");

-- CreateIndex
CREATE INDEX "consumed_claim_tokens_shopDomain_idx" ON "consumed_claim_tokens"("shopDomain");

-- CreateIndex
CREATE INDEX "pending_claims_shopDomain_idx" ON "pending_claims"("shopDomain");

-- CreateIndex
CREATE INDEX "pending_claims_expiresAt_idx" ON "pending_claims"("expiresAt");

-- CreateIndex
CREATE INDEX "store_access_requests_storeId_idx" ON "store_access_requests"("storeId");

-- CreateIndex
CREATE INDEX "store_access_requests_organizationId_idx" ON "store_access_requests"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "store_access_requests_storeId_requestedByUserId_status_key" ON "store_access_requests"("storeId", "requestedByUserId", "status");

-- AddForeignKey
ALTER TABLE "store_access_requests" ADD CONSTRAINT "store_access_requests_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_access_requests" ADD CONSTRAINT "store_access_requests_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
