import { prisma } from "../lib/prisma";
import {
  publishConversationCreated,
  publishMessageCreated,
} from "../realtime/hub";
import { findCustomerByIdentity } from "./customer.repository";
import { findPublicActiveService } from "./service.repository";
import type {
  PublicLeadInput,
  PublicLeadResult,
} from "../validation/public-lead.schemas";

/**
 * Public lead capture pipeline (FEATURES §21, IMPLEMENTATION_PLAN step 18):
 * validate business → find/create customer → create lead → create
 * conversation → trigger AI (step 20 hook, called by the controller).
 *
 * The businessRef is the business id — the same value the business owner
 * pastes into the embed snippet (§21 example). It is validated here against
 * the database, never trusted: unknown → "not_found" (404, no existence
 * leak beyond what the public snippet already reveals), SUSPENDED →
 * "suspended" (403, §8).
 *
 * Duplicate submissions (same customer + same message within a short
 * window) return the existing lead instead of creating a second one —
 * impatient double-clicks and browser retries are common on contact forms.
 */

export type CaptureOutcome =
  | { ok: true; result: PublicLeadResult; duplicate: boolean }
  | { ok: false; reason: "not_found" | "suspended" };

/** Identical submissions inside this window collapse into one lead. */
const DUPLICATE_WINDOW_MS = 15 * 60 * 1000;

export async function capturePublicLead(
  businessRef: string,
  input: PublicLeadInput,
): Promise<CaptureOutcome> {
  const business = await prisma.business.findUnique({
    where: { id: businessRef },
    select: { id: true, status: true },
  });
  if (!business) return { ok: false, reason: "not_found" };
  if (business.status !== "ACTIVE") return { ok: false, reason: "suspended" };

  // Find-or-create the customer by phone/email within this business only
  // (§14) — the same person submitting again reuses their row.
  let customer = await findCustomerByIdentity(business.id, {
    phone: input.phone,
    email: input.email,
  });
  if (!customer) {
    customer = await prisma.customer.create({
      data: {
        businessId: business.id,
        name: input.name,
        email: input.email ?? null,
        phone: input.phone ?? null,
        postcode: input.postcode ?? null,
      },
    });
  }

  // Duplicate submission → hand back the lead we already captured.
  const recent = await prisma.lead.findFirst({
    where: {
      businessId: business.id,
      customerId: customer.id,
      source: "WEBSITE",
      customerMessage: input.message,
      createdAt: { gte: new Date(Date.now() - DUPLICATE_WINDOW_MS) },
    },
    orderBy: { createdAt: "desc" },
    include: {
      conversations: {
        select: { id: true, status: true },
        take: 1,
        orderBy: { createdAt: "desc" },
      },
    },
  });
  if (recent) {
    return {
      ok: true,
      duplicate: true,
      result: {
        lead: {
          id: recent.id,
          status: recent.status,
          createdAt: recent.createdAt,
        },
        conversation: recent.conversations[0] ?? null,
      },
    };
  }

  // Service: the widget's select sends the serviceId, while the free-text
  // serviceName still works for hand-rolled embeds and is matched by name.
  // Either way the service must belong to THIS business and be active — a
  // foreign or archived id is ignored, never linked (§13, §16). No match is
  // fine: the lead stays valid without one (§15), and the AI clarifies it.
  let serviceId: string | null = input.serviceId
    ? (await findPublicActiveService(business.id, input.serviceId))?.id ?? null
    : null;
  if (!serviceId && input.serviceName) {
    const services = await prisma.service.findMany({
      where: { businessId: business.id, active: true },
      select: { id: true, name: true },
    });
    const wanted = input.serviceName.toLowerCase();
    serviceId =
      services.find((service) => service.name.toLowerCase() === wanted)?.id ??
      null;
  }

  const { lead, conversation, message } = await prisma.$transaction(async (tx) => {
    const lead = await tx.lead.create({
      data: {
        businessId: business.id,
        customerId: customer.id,
        serviceId,
        urgency: input.urgency ?? null,
        preferredDate: input.preferredDate ?? null,
        source: "WEBSITE",
        postcode: input.postcode ?? null,
        customerMessage: input.message,
      },
    });
    // Every enquiry belongs to a conversation (§19) so the AI (step 20) and
    // staff takeover (step 24) both have a thread from the first day.
    const conversation = await tx.conversation.create({
      data: {
        businessId: business.id,
        customerId: customer.id,
        leadId: lead.id,
        channel: "WEBSITE",
      },
    });
    // The enquiry itself is the thread's first message. Without it the
    // dashboard thread renders empty and the agent sees "no customer message"
    // and stays silent — the enquiry would be invisible on both sides (§20).
    const message = await tx.message.create({
      data: {
        conversationId: conversation.id,
        sender: "CUSTOMER",
        content: input.message,
        channel: "WEBSITE",
      },
    });
    return { lead, conversation, message };
  });

  // A new enquiry thread plus its first message, live for every open
  // dashboard (§38).
  publishConversationCreated(business.id, conversation.id);
  publishMessageCreated(business.id, message);

  return {
    ok: true,
    duplicate: false,
    result: {
      lead: { id: lead.id, status: lead.status, createdAt: lead.createdAt },
      conversation: { id: conversation.id, status: conversation.status },
    },
  };
}
