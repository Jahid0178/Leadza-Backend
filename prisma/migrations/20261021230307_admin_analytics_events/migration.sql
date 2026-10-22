-- CreateEnum
CREATE TYPE "AnalyticsEventType" AS ENUM ('LEAD_STATUS_CHANGED', 'CONVERSATION_ESCALATED', 'AI_RUN_FAILED', 'CHANNEL_INTEGRATION_FAILED', 'CHANNEL_INTEGRATION_RECOVERED');

-- CreateTable
CREATE TABLE "analytics_events" (
    "id" TEXT NOT NULL,
    "type" "AnalyticsEventType" NOT NULL,
    "businessId" TEXT NOT NULL,
    "leadId" TEXT,
    "conversationId" TEXT,
    "fromStatus" TEXT,
    "toStatus" TEXT,
    "initiator" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analytics_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "analytics_events_type_createdAt_idx" ON "analytics_events"("type", "createdAt");

-- CreateIndex
CREATE INDEX "analytics_events_businessId_createdAt_idx" ON "analytics_events"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "analytics_events_conversationId_idx" ON "analytics_events"("conversationId");

-- CreateIndex
CREATE INDEX "analytics_events_leadId_idx" ON "analytics_events"("leadId");

-- CreateIndex
CREATE INDEX "bookings_createdAt_idx" ON "bookings"("createdAt");

-- CreateIndex
CREATE INDEX "conversations_createdAt_idx" ON "conversations"("createdAt");

-- CreateIndex
CREATE INDEX "leads_createdAt_idx" ON "leads"("createdAt");
