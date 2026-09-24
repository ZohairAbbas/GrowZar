-- AlterTable
ALTER TABLE "member" ADD COLUMN     "scopeAllStores" BOOLEAN DEFAULT true;

-- CreateTable
CREATE TABLE "member_store_scopes" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "member_store_scopes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "member_store_scopes_memberId_idx" ON "member_store_scopes"("memberId");

-- CreateIndex
CREATE INDEX "member_store_scopes_storeId_idx" ON "member_store_scopes"("storeId");

-- CreateIndex
CREATE UNIQUE INDEX "member_store_scopes_memberId_storeId_key" ON "member_store_scopes"("memberId", "storeId");

-- AddForeignKey
ALTER TABLE "member_store_scopes" ADD CONSTRAINT "member_store_scopes_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_store_scopes" ADD CONSTRAINT "member_store_scopes_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;
