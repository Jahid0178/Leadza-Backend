import { z } from "zod";

/**
 * FAQ = a question customers ask (answered in question/answer form);
 * BUSINESS = general information about the business, its services or policies.
 */
export const knowledgeEntryTypeSchema = z.enum(["FAQ", "BUSINESS"]);

export type KnowledgeEntryType = z.infer<typeof knowledgeEntryTypeSchema>;

const question = z
  .string()
  .trim()
  .min(3, "Question must be at least 3 characters.")
  .max(300, "Question must be 300 characters or fewer.");

const answer = z
  .string()
  .trim()
  .min(3, "Answer must be at least 3 characters.")
  .max(4000, "Answer must be 4000 characters or fewer.");

/** Free-text category label, e.g. "Services" or "Pricing & payments". */
const category = z
  .string()
  .trim()
  .min(1, "Category is required.")
  .max(60, "Category must be 60 characters or fewer.");

const tags = z
  .array(
    z
      .string()
      .trim()
      .min(1, "Tags cannot be empty.")
      .max(30, "Tags must be 30 characters or fewer."),
  )
  .max(10, "Use up to 10 tags.");

/** POST /api/v1/businesses/:businessId/knowledge — add a knowledge entry. */
export const createKnowledgeSchema = z.object({
  businessId: z.string().trim().min(1, "Business is required."),
  question,
  answer,
  type: knowledgeEntryTypeSchema.default("FAQ"),
  category: category.default("FAQ"),
  tags: tags.default([]),
  // Published (true) vs Draft (false); drafts stay visible in the dashboard
  // but are never offered to the AI (FEATURES §13).
  isActive: z.boolean().default(true),
});

export type CreateKnowledgeInput = z.infer<typeof createKnowledgeSchema>;

/** PATCH /api/v1/knowledge/:entryId — at least one editable field required. */
export const updateKnowledgeSchema = z
  .object({
    question: question.optional(),
    answer: answer.optional(),
    type: knowledgeEntryTypeSchema.optional(),
    category: category.optional(),
    tags: tags.optional(),
    isActive: z.boolean().optional(),
  })
  .refine(
    (values) => {
      const keys = ["question", "answer", "type", "category", "tags", "isActive"] as const;
      return keys.some((key) => values[key] !== undefined);
    },
    { message: "No fields to update." },
  );

export type UpdateKnowledgeInput = z.infer<typeof updateKnowledgeSchema>;

/** Public knowledge-entry shape returned by the API. */
export interface KnowledgeDto {
  id: string;
  businessId: string;
  question: string;
  answer: string;
  type: KnowledgeEntryType;
  category: string;
  tags: string[];
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}
