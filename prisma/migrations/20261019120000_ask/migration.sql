-- "Talk to your data" (G-GZR10-2): the organization switch and cap, conversations, messages and monthly usage.
-- CreateTable
CREATE TABLE "ask_settings" (
    "organizationId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "monthlyCapMicros" BIGINT NOT NULL DEFAULT 5000000,
    "changedByUserId" TEXT,
    "changedAt" TIMESTAMP(3),
    CONSTRAINT "ask_settings_pkey" PRIMARY KEY ("organizationId")
);
-- CreateTable
CREATE TABLE "ask_conversations" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "storeIds" TEXT[],
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ask_conversations_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "ask_messages" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "text" TEXT,
    "toolCalls" JSONB,
    "toolResultRefs" TEXT[],
    "model" TEXT,
    "status" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "cachedTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "reasoningTokens" INTEGER NOT NULL DEFAULT 0,
    "costMicros" BIGINT NOT NULL DEFAULT 0,
    "latencyMs" INTEGER,
    "grounded" BOOLEAN,
    "feedback" TEXT,
    "feedbackNote" TEXT,
    "redactedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ask_messages_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "ask_usage_monthly" (
    "organizationId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "questions" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" BIGINT NOT NULL DEFAULT 0,
    "cachedTokens" BIGINT NOT NULL DEFAULT 0,
    "outputTokens" BIGINT NOT NULL DEFAULT 0,
    "costMicros" BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT "ask_usage_monthly_pkey" PRIMARY KEY ("organizationId","month")
);
-- CreateIndex
CREATE INDEX "ask_conversations_organizationId_userId_startedAt_idx" ON "ask_conversations"("organizationId", "userId", "startedAt");
-- CreateIndex
CREATE INDEX "ask_messages_conversationId_createdAt_idx" ON "ask_messages"("conversationId", "createdAt");
-- CreateIndex
CREATE INDEX "ask_messages_createdAt_idx" ON "ask_messages"("createdAt");
-- AddForeignKey
ALTER TABLE "ask_settings" ADD CONSTRAINT "ask_settings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "ask_conversations" ADD CONSTRAINT "ask_conversations_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "ask_messages" ADD CONSTRAINT "ask_messages_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "ask_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "ask_usage_monthly" ADD CONSTRAINT "ask_usage_monthly_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
