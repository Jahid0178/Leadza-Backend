-- Knowledge redesign: entry type, free-text categories, tags and a draft
-- status that is distinct from being archived. Written by hand (instead of
-- generated) so no existing row is dropped or rewritten with defaults.

-- CreateEnum
CREATE TYPE "KnowledgeEntryType" AS ENUM ('FAQ', 'BUSINESS');

-- AlterTable: entry type, derived from the legacy category so existing rows
-- keep their meaning (FAQ stays FAQ, everything else is business information).
ALTER TABLE "knowledge_entries" ADD COLUMN "type" "KnowledgeEntryType" NOT NULL DEFAULT 'FAQ';
UPDATE "knowledge_entries" SET "type" = 'BUSINESS' WHERE "category" <> 'FAQ';

-- AlterTable: tags, for organisation and search.
ALTER TABLE "knowledge_entries" ADD COLUMN "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "knowledge_entries" ALTER COLUMN "tags" SET NOT NULL;

-- AlterTable: archive timestamp — a draft (isActive=false) must stay visible
-- while an archived entry disappears from the dashboard list.
ALTER TABLE "knowledge_entries" ADD COLUMN "archivedAt" TIMESTAMP(3);
UPDATE "knowledge_entries" SET "archivedAt" = "updatedAt" WHERE "isActive" = false;

-- AlterTable: category enum -> free text, mapped to the previous display
-- labels so nothing reads as a raw enum value afterwards.
ALTER TABLE "knowledge_entries" ADD COLUMN "categoryText" TEXT;
UPDATE "knowledge_entries" SET "categoryText" = CASE "category"
    WHEN 'FAQ' THEN 'FAQ'
    WHEN 'POLICY' THEN 'Policy'
    WHEN 'EMERGENCY' THEN 'Emergency rule'
    WHEN 'CANCELLATION' THEN 'Cancellation'
    WHEN 'OTHER' THEN 'Other'
END;
ALTER TABLE "knowledge_entries" ALTER COLUMN "categoryText" SET NOT NULL;
ALTER TABLE "knowledge_entries" ALTER COLUMN "categoryText" SET DEFAULT 'FAQ';
ALTER TABLE "knowledge_entries" DROP COLUMN "category";
ALTER TABLE "knowledge_entries" RENAME COLUMN "categoryText" TO "category";

-- DropEnum
DROP TYPE "KnowledgeCategory";
