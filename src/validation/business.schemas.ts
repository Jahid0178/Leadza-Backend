import { z } from "zod";

/**
 * Business profile validation (FEATURES §8, agent.md §14).
 * Step 08 (onboarding) extends this with the full profile field set.
 */
export const updateBusinessSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "Business name must be at least 2 characters.")
    .max(100, "Business name must be 100 characters or fewer."),
});

export type UpdateBusinessInput = z.infer<typeof updateBusinessSchema>;
