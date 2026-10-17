import type {
  AppendMessageInput,
  ConversationChannel,
  ConversationDto,
  CreateConversationInput,
  ListConversationsQuery,
  MessageDto,
  MessageSender,
} from "../validation/conversation.schemas";
import { prisma } from "../lib/prisma";
import {
  publishConversationCreated,
  publishConversationUpdated,
  publishMessageCreated,
} from "../realtime/hub";
import { findMembership } from "./membership.repository";
import {
  canTransitionConversation,
  type ConversationStatus,
} from "../services/conversation-status";

/** Relations every conversation row needs (§31: customer, lead, assignee, last message). */
export interface ConversationWithRelations extends ConversationDto {
  customer: { id: string; name: string; phone: string | null; email: string | null };
  lead: { id: string; status: string } | null;
  assignedTo: { id: string; name: string | null } | null;
  lastMessage: { content: string; sender: MessageSender; createdAt: Date } | null;
}

/** A conversation plus the caller's role for API responses. */
export interface ConversationWithRole extends ConversationWithRelations {
  role: "OWNER" | "ADMIN" | "STAFF";
}

/** A conversation with its full message history (§30–31 thread view). */
export interface ConversationDetail extends ConversationWithRelations {
  messages: MessageDto[];
}

export interface ConversationPage {
  conversations: ConversationWithRelations[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * Tenant-scoped conversation access (FEATURES §19, §31, agent.md §13).
 * Every function verifies membership with the authenticated userId before
 * touching the row, so a businessId never comes from the client.
 */

/** Filters a list query can carry; businessId may also be an id set. */
interface ConversationWhereInput {
  businessId: string | { in: string[] };
  status?: ConversationStatus;
  channel?: ConversationChannel;
  assignedToId?: string;
  customerId?: string;
  leadId?: string;
  search?: string;
}

/** Build the tenant-scoped Prisma where clause for a list query. */
function conversationWhere(query: ConversationWhereInput) {
  const where: Record<string, unknown> = { businessId: query.businessId };

  if (query.status) where.status = query.status;
  if (query.channel) where.channel = query.channel;
  if (query.assignedToId) where.assignedToId = query.assignedToId;
  if (query.customerId) where.customerId = query.customerId;
  if (query.leadId) where.leadId = query.leadId;

  if (query.search) {
    // Search across the customer's contact details (§31 customer column).
    where.customer = {
      OR: [
        { name: { contains: query.search, mode: "insensitive" } },
        { phone: { contains: query.search, mode: "insensitive" } },
        { email: { contains: query.search, mode: "insensitive" } },
      ],
    };
  }

  return where;
}

/** Attach customer, lead, assignee and last-message preview to conversation rows. */
async function withRelations(
  conversations: ConversationDto[],
): Promise<ConversationWithRelations[]> {
  if (conversations.length === 0) return [];

  const ids = conversations.map((c) => c.id);

  const [customers, leads, assignees, messages] = await Promise.all([
    prisma.customer.findMany({
      where: { id: { in: conversations.map((c) => c.customerId) } },
      select: { id: true, name: true, phone: true, email: true },
    }),
    prisma.lead.findMany({
      where: {
        id: { in: conversations.map((c) => c.leadId).filter(Boolean) as string[] },
      },
      select: { id: true, status: true },
    }),
    prisma.user.findMany({
      where: {
        id: {
          in: conversations
            .map((c) => c.assignedToId)
            .filter(Boolean) as string[],
        },
      },
      select: { id: true, name: true },
    }),
    prisma.message.findMany({
      where: { conversationId: { in: ids } },
      orderBy: { createdAt: "desc" },
      select: { conversationId: true, content: true, sender: true, createdAt: true },
    }),
  ]);

  const customerById = new Map(customers.map((c) => [c.id, c]));
  const leadById = new Map(leads.map((l) => [l.id, l]));
  const userById = new Map(assignees.map((u) => [u.id, u]));

  // Messages are newest-first, so the first hit per conversation is the latest.
  const lastMessageByConversation = new Map<
    string,
    { content: string; sender: MessageSender; createdAt: Date }
  >();
  for (const message of messages) {
    if (!lastMessageByConversation.has(message.conversationId)) {
      lastMessageByConversation.set(message.conversationId, {
        content: message.content,
        sender: message.sender as MessageSender,
        createdAt: message.createdAt,
      });
    }
  }

  return conversations.map((conversation) => {
    const lead = conversation.leadId ? leadById.get(conversation.leadId) : undefined;
    return {
      ...conversation,
      customer: customerById.get(conversation.customerId) ?? {
        id: conversation.customerId,
        name: "Unknown customer",
        phone: null,
        email: null,
      },
      lead: lead ? { id: lead.id, status: lead.status } : null,
      assignedTo: conversation.assignedToId
        ? (userById.get(conversation.assignedToId) ?? null)
        : null,
      lastMessage: lastMessageByConversation.get(conversation.id) ?? null,
    };
  });
}

/**
 * List conversations for one business the caller belongs to, with filters +
 * pagination (§31). Returns null when the caller is not a member (404).
 */
export async function listConversationsForBusiness(
  userId: string,
  query: ListConversationsQuery,
  businessId: string,
): Promise<ConversationPage | null> {
  const membership = await findMembership(userId, businessId);
  if (!membership) return null;

  const where = conversationWhere({ ...query, businessId });
  const skip = (query.page - 1) * query.pageSize;

  const [rows, total] = await Promise.all([
    prisma.conversation.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      skip,
      take: query.pageSize,
    }),
    prisma.conversation.count({ where }),
  ]);

  return {
    conversations: await withRelations(rows),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

/** List conversations across all the caller's businesses (most recent first). */
export async function listConversationsForUser(
  userId: string,
  query: Omit<ListConversationsQuery, "businessId">,
): Promise<ConversationWithRelations[]> {
  const memberships = await prisma.businessMember.findMany({
    where: { userId },
    select: { businessId: true },
  });
  if (memberships.length === 0) return [];

  const where = conversationWhere({
    ...query,
    businessId: { in: memberships.map((m) => m.businessId) },
  });

  const rows = await prisma.conversation.findMany({
    where,
    orderBy: { updatedAt: "desc" },
    take: query.pageSize,
  });

  return withRelations(rows);
}

/** Read one conversation (with its messages) if the caller is a member. */
export async function findConversationForUser(
  userId: string,
  conversationId: string,
): Promise<ConversationDetail | null> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
  });
  if (!conversation) return null;

  const membership = await findMembership(userId, conversation.businessId);
  if (!membership) return null;

  const [withRel] = await withRelations([conversation]);
  if (!withRel) return null;

  const messages = await prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: "asc" },
  });

  return { ...withRel, messages: messages as MessageDto[] };
}

/** Open a conversation for a customer the caller's business owns (any role). */
export async function createConversationForUser(
  userId: string,
  input: CreateConversationInput,
): Promise<ConversationWithRole | null> {
  const membership = await findMembership(userId, input.businessId);
  if (!membership) return null;

  // The customer must belong to the same business (§13).
  const customer = await prisma.customer.findFirst({
    where: { id: input.customerId, businessId: input.businessId },
    select: { id: true },
  });
  if (!customer) return null;

  // A linked lead, when named, must also belong to this business.
  if (input.leadId) {
    const lead = await prisma.lead.findFirst({
      where: { id: input.leadId, businessId: input.businessId },
      select: { id: true },
    });
    if (!lead) return null;
  }

  const conversation = await prisma.conversation.create({
    data: {
      businessId: input.businessId,
      customerId: input.customerId,
      leadId: input.leadId ?? null,
      channel: input.channel,
    },
  });

  // A new thread must appear in every open dashboard (§38).
  publishConversationCreated(input.businessId, conversation.id);

  const [withRel] = await withRelations([conversation]);
  return withRel ? { ...withRel, role: membership.role } : null;
}

/** Outcome of a status change: the updated conversation or the reason. */
export type ConversationStatusChangeResult =
  | { ok: true; conversation: ConversationWithRole }
  | { ok: false; reason: "not_found" | "invalid_transition" };

/**
 * Change a conversation's status — the ONLY way status changes (agent.md §19).
 * Invalid jumps are rejected with the backend-owned transition table.
 */
export async function changeConversationStatusForUser(
  userId: string,
  conversationId: string,
  to: ConversationStatus,
): Promise<ConversationStatusChangeResult> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
  });
  if (!conversation) return { ok: false, reason: "not_found" };

  const membership = await findMembership(userId, conversation.businessId);
  if (!membership) return { ok: false, reason: "not_found" };

  if (
    !canTransitionConversation(
      conversation.status as ConversationStatus,
      to,
    )
  ) {
    return { ok: false, reason: "invalid_transition" };
  }

  const updated = await prisma.conversation.update({
    where: { id: conversationId },
    data: { status: to },
  });

  publishConversationUpdated(
    conversation.businessId,
    conversationId,
    to,
    updated.assignedToId,
  );

  const [withRel] = await withRelations([updated]);
  if (!withRel) return { ok: false, reason: "not_found" };
  return { ok: true, conversation: { ...withRel, role: membership.role } };
}

/**
 * Append a staff reply (§32). Sending a message moves the conversation to
 * HUMAN_ACTIVE and records the sender as the assignee, so the AI stops
 * responding (step 24 wires the notification).
 */
export async function appendMessageForUser(
  userId: string,
  conversationId: string,
  input: AppendMessageInput,
): Promise<{ message: MessageDto; conversation: ConversationWithRole } | null> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
  });
  if (!conversation) return null;

  const membership = await findMembership(userId, conversation.businessId);
  if (!membership) return null;

  const message = await prisma.message.create({
    data: {
      conversationId,
      sender: "HUMAN",
      content: input.content,
      channel: conversation.channel,
      aiGenerated: false,
    },
  });

  const updated = await prisma.conversation.update({
    where: { id: conversationId },
    data: { status: "HUMAN_ACTIVE", assignedToId: userId },
  });

  // The thread is live for every other dashboard too (§38).
  publishMessageCreated(conversation.businessId, message);
  publishConversationUpdated(
    conversation.businessId,
    conversationId,
    "HUMAN_ACTIVE",
    userId,
  );

  const [withRel] = await withRelations([updated]);
  if (!withRel) return null;

  return {
    message: message as MessageDto,
    conversation: { ...withRel, role: membership.role },
  };
}
