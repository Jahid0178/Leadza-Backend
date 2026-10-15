import type { Request, Response } from "express";
import { triggerAiReply } from "../services/ai-trigger";
import { capturePublicLead } from "../repositories/public-lead.repository";
import { ApiError } from "../utils/api-error";
import { apiSuccess } from "../utils/api-response";
import { publicLeadSchema } from "../validation/public-lead.schemas";

/**
 * Public lead controller (FEATURES §21, IMPLEMENTATION_PLAN step 18).
 *
 * The only unauthenticated write path in the API: an anonymous website
 * visitor submits the embed form. Everything tenant-specific is validated
 * server-side — the business comes from the URL and must be ACTIVE, the
 * customer is matched within that business only, and no client value is
 * ever trusted as an identity (§7, §52).
 */

/**
 * POST /api/v1/leads/public/:businessRef — capture an enquiry.
 *
 * Order matters: honeypot before validation (bots that fill it get a
 * plausible success with nothing stored, so they don't adapt), validation
 * before any database work, AI trigger only after a real conversation
 * exists.
 */
export async function submitPublicLead(req: Request, res: Response) {
  const businessRef = req.params.businessRef;
  if (typeof businessRef !== "string" || businessRef.trim().length === 0) {
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }

  // Honeypot: the widget renders this field invisibly; humans never fill
  // it. Answer like a success so bots get no signal (agent.md §25 spirit:
  // never teach the attacker).
  const honeypot = (req.body as { website?: unknown } | null)?.website;
  if (typeof honeypot === "string" && honeypot.trim().length > 0) {
    res.status(201).json(apiSuccess({ accepted: true }));
    return;
  }

  const parsed = publicLeadSchema.safeParse(req.body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.join(".");
    throw ApiError.badRequest(
      "VALIDATION_ERROR",
      field ? `${field}: ${issue?.message}` : (issue?.message ?? "Invalid input."),
    );
  }

  const outcome = await capturePublicLead(businessRef, parsed.data);
  if (!outcome.ok) {
    if (outcome.reason === "suspended") {
      throw ApiError.forbidden(
        "BUSINESS_SUSPENDED",
        "This business isn't accepting enquiries right now. Please contact them directly.",
      );
    }
    throw ApiError.notFound("NOT_FOUND", "The requested resource was not found.");
  }

  // Kick off the AI (no-op until step 20) — never awaited into the
  // request path once the real background job lands (§59).
  if (outcome.result.conversation) {
    void triggerAiReply(outcome.result.conversation.id);
  }

  // A duplicate answers 200 (not 201): nothing was created this time.
  res.status(outcome.duplicate ? 200 : 201).json(
    apiSuccess({
      accepted: true,
      duplicate: outcome.duplicate,
      lead: outcome.result.lead,
      conversation: outcome.result.conversation,
    }),
  );
}
