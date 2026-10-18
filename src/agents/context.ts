import { env } from "../config/env";
import { prisma } from "../lib/prisma";
import { isOpenAt } from "../services/businesshour.service";
import type { AiChatMessage } from "./provider";

/**
 * Agent context loader (FEATURES §23, IMPLEMENTATION_PLAN step 20).
 *
 * Assembles exactly the facts the model is allowed to reason about — the
 * current message, recent history, the customer, the lead, the business and
 * its services / areas / knowledge / hours. Nothing else reaches the model,
 * which is what makes "never invent business information" (§25, agent.md §17)
 * enforceable: if a fact is absent here, the model has no basis to state it.
 *
 * All reads are scoped by the conversation's own businessId, resolved from
 * the database, never from a caller-supplied value (§7, §52).
 */

export interface AgentBusiness {
  id: string;
  name: string;
  type: string | null;
  description: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  currency: string;
  locale: string;
  timezone: string;
}

export interface AgentCustomer {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  postcode: string | null;
  address: string | null;
}

export interface AgentLead {
  id: string;
  status: string;
  urgency: string | null;
  location: string | null;
  postcode: string | null;
  budget: number | null;
  preferredDate: Date | null;
  preferredTime: string | null;
  customerMessage: string | null;
  serviceId: string | null;
  leadScore: number | null;
}

export interface AgentService {
  id: string;
  name: string;
  description: string | null;
  price: number | null;
  priceType: string;
  duration: number | null;
}

export interface AgentKnowledge {
  question: string;
  answer: string;
  category: string;
}

export interface AgentAvailability {
  /**
   * True only when the business has configured at least one BusinessHour row.
   * Without hours there is no verified opening state, so the guardrails block
   * any open/closed claim (§25: never invent availability).
   */
  verified: boolean;
  open: boolean;
  emergency: boolean;
  /** Business-local weekday + "HH:MM" of the moment the context was built. */
  weekday: string;
  time: string;
}

export interface AgentContext {
  conversation: {
    id: string;
    businessId: string;
    customerId: string;
    leadId: string | null;
    channel: string;
    status: string;
  };
  business: AgentBusiness;
  customer: AgentCustomer;
  lead: AgentLead | null;
  services: AgentService[];
  serviceAreas: string[];
  knowledge: AgentKnowledge[];
  availability: AgentAvailability;
  /** Prior turns, oldest first, for the model's chat history. */
  history: AiChatMessage[];
  /**
   * The customer message the agent is answering. Null when the last message
   * is not from the customer — there is nothing new to reply to, so the agent
   * must stay quiet rather than send an unsolicited message.
   */
  currentMessage: string | null;
}

/** Map a stored message to a chat role; SYSTEM notes are not replayed. */
function toChatRole(sender: string): AiChatMessage["role"] | null {
  switch (sender) {
    case "CUSTOMER":
      return "user";
    case "AI":
    case "HUMAN":
      return "assistant";
    default:
      return null;
  }
}

export async function loadAgentContext(
  conversationId: string,
): Promise<AgentContext | null> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: { business: true, customer: true, lead: true },
  });
  if (!conversation) return null;

  const businessId = conversation.businessId;

  const [messages, services, areas, knowledge, hourCount, availability] =
    await Promise.all([
      prisma.message.findMany({
        where: { conversationId },
        orderBy: { createdAt: "asc" },
      }),
      prisma.service.findMany({
        where: { businessId, active: true },
        orderBy: { name: "asc" },
      }),
      prisma.serviceArea.findMany({
        where: { businessId },
        orderBy: { value: "asc" },
      }),
      prisma.knowledgeEntry.findMany({
        where: { businessId, isActive: true, archivedAt: null },
        orderBy: { createdAt: "asc" },
      }),
      prisma.businessHour.count({ where: { businessId } }),
      isOpenAt(businessId, new Date(), conversation.business.timezone),
    ]);

  const last = messages[messages.length - 1];
  const currentMessage = last && last.sender === "CUSTOMER" ? last.content : null;
  const prior = currentMessage ? messages.slice(0, -1) : messages;

  const history: AiChatMessage[] = prior
    .slice(-env.AI_HISTORY_LIMIT)
    .map((message) => {
      const role = toChatRole(message.sender);
      return role ? { role, content: message.content } : null;
    })
    .filter((entry): entry is AiChatMessage => entry !== null);

  return {
    conversation: {
      id: conversation.id,
      businessId: conversation.businessId,
      customerId: conversation.customerId,
      leadId: conversation.leadId,
      channel: conversation.channel,
      status: conversation.status,
    },
    business: {
      id: conversation.business.id,
      name: conversation.business.name,
      type: conversation.business.type,
      description: conversation.business.description,
      phone: conversation.business.phone,
      email: conversation.business.email,
      website: conversation.business.website,
      currency: conversation.business.currency,
      locale: conversation.business.locale,
      timezone: conversation.business.timezone,
    },
    customer: {
      id: conversation.customer.id,
      name: conversation.customer.name,
      email: conversation.customer.email,
      phone: conversation.customer.phone,
      postcode: conversation.customer.postcode,
      address: conversation.customer.address,
    },
    lead: conversation.lead
      ? {
          id: conversation.lead.id,
          status: conversation.lead.status,
          urgency: conversation.lead.urgency,
          location: conversation.lead.location,
          postcode: conversation.lead.postcode,
          budget: conversation.lead.budget,
          preferredDate: conversation.lead.preferredDate,
          preferredTime: conversation.lead.preferredTime,
          customerMessage: conversation.lead.customerMessage,
          serviceId: conversation.lead.serviceId,
          leadScore: conversation.lead.leadScore,
        }
      : null,
    services: services.map((service) => ({
      id: service.id,
      name: service.name,
      description: service.description,
      price: service.price,
      priceType: service.priceType,
      duration: service.duration,
    })),
    serviceAreas: areas.map((area) => area.label ?? area.value),
    knowledge: knowledge.map((entry) => ({
      question: entry.question,
      answer: entry.answer,
      category: entry.category,
    })),
    availability: {
      verified: hourCount > 0,
      open: availability.open,
      emergency: availability.emergency,
      weekday: availability.weekday,
      time: availability.time,
    },
    history,
    currentMessage,
  };
}
