import { z } from "zod";

/** Paddle billing request schemas (IMPLEMENTATION_PLAN Phase H). */

/** POST /api/v1/paddle/portal — open the hosted portal for a business. */
export const paddlePortalSchema = z.object({
  businessId: z.string().min(1, "businessId is required"),
});

export type PaddlePortalInput = z.infer<typeof paddlePortalSchema>;

/**
 * POST /api/v1/paddle/reconcile — mirror current Paddle state for a business.
 * `transactionId` is the `_ptxn` value Paddle appends to the success URL.
 */
export const paddleReconcileSchema = z.object({
  businessId: z.string().min(1, "businessId is required"),
  transactionId: z.string().min(1).optional(),
});

export type PaddleReconcileInput = z.infer<typeof paddleReconcileSchema>;

/** GET /api/v1/paddle/status?businessId=… */
export const paddleStatusQuerySchema = z.object({
  businessId: z.string().min(1, "businessId is required"),
});
