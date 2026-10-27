-- "This looks wrong" on Plan's Beta forecasts and return-risk bands (pre-Wave-1 pack 2).
-- CreateTable
CREATE TABLE "product_feedback" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "note" TEXT,
    "subject" TEXT,
    "inputs" JSONB NOT NULL,
    "version" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "product_feedback_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE INDEX "product_feedback_organizationId_createdAt_idx" ON "product_feedback"("organizationId", "createdAt");
-- CreateIndex
CREATE INDEX "product_feedback_tool_createdAt_idx" ON "product_feedback"("tool", "createdAt");
-- AddForeignKey
ALTER TABLE "product_feedback" ADD CONSTRAINT "product_feedback_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
