-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "publicToken" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "conversations_publicToken_key" ON "conversations"("publicToken");

