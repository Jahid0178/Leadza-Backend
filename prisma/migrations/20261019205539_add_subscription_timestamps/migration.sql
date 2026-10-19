-- AlterTable
ALTER TABLE "subscriptions" ADD COLUMN     "next_billed_at" TIMESTAMP(3),
ADD COLUMN     "paddle_created_at" TIMESTAMP(3);
