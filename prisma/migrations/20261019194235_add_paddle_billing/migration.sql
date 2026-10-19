-- CreateTable
CREATE TABLE "billing_customers" (
    "customer_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "business_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_customers_pkey" PRIMARY KEY ("customer_id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "subscription_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "business_id" TEXT,
    "status" TEXT NOT NULL,
    "price_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "scheduled_change_action" TEXT,
    "scheduled_change_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("subscription_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "billing_customers_business_id_key" ON "billing_customers"("business_id");

-- CreateIndex
CREATE INDEX "billing_customers_business_id_idx" ON "billing_customers"("business_id");

-- CreateIndex
CREATE INDEX "subscriptions_business_id_idx" ON "subscriptions"("business_id");

-- CreateIndex
CREATE INDEX "subscriptions_customer_id_idx" ON "subscriptions"("customer_id");

-- AddForeignKey
ALTER TABLE "billing_customers" ADD CONSTRAINT "billing_customers_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "billing_customers"("customer_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE SET NULL ON UPDATE CASCADE;
