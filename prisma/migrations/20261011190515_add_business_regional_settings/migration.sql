-- AlterTable
ALTER TABLE "businesses" ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'GBP',
ADD COLUMN     "locale" TEXT NOT NULL DEFAULT 'en-GB',
ADD COLUMN     "timezone" TEXT NOT NULL DEFAULT 'Europe/London';
