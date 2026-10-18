import type {
  ConversationChannel,
  MessageSender,
} from "../validation/conversation.schemas";
import type { ConversationStatus } from "../services/conversation-status";
import type { BookingStatus } from "../services/booking-status";
import { logger } from "../utils/logger";

/**
 * Realtime event hub (IMPLEMENTATION_PLAN step 38).
 *
 * Every write path that changes a conversation — customer message, AI reply,
 * staff reply, status change, new thread — publishes a typed event here. The
 * transport (socket.io, see ./server.ts) is attached at boot; in tests and
 * one-off scripts nothing is attached and publishing is a no-op, so a write
 * never depends on a socket server being up.
 *
 * Events are per business and carry only what the dashboard needs to render
 * the change; the client still refetches from the API, so a dropped event
 * degrades to "next reload" rather than corrupt state.
 */

/** The message shape the dashboard renders (dates as ISO strings). */
export interface RealtimeMessage {
  id: string;
  conversationId: string;
  sender: MessageSender;
  content: string;
  channel: ConversationChannel;
  aiGenerated: boolean;
  externalMessageId: string | null;
  createdAt: string;
}

/** Who is currently typing in a conversation (see ./typing.ts). */
export interface TypingRoles {
  CUSTOMER: boolean;
  HUMAN: boolean;
  AI: boolean;
}

export type RealtimeEvent =
  | {
      type: "message.created";
      businessId: string;
      conversationId: string;
      message: RealtimeMessage;
    }
  | {
      type: "conversation.created";
      businessId: string;
      conversationId: string;
    }
  | {
      type: "conversation.updated";
      businessId: string;
      conversationId: string;
      status: ConversationStatus;
      assignedToId: string | null;
    }
  | {
      type: "typing.updated";
      businessId: string;
      conversationId: string;
      typing: TypingRoles;
    }
  | {
      type: "booking.created";
      businessId: string;
      bookingId: string;
    }
  | {
      type: "booking.updated";
      businessId: string;
      bookingId: string;
      status: BookingStatus;
      startAt: string;
      endAt: string;
    };

/** Delivers one event to every socket subscribed to the business. */
export interface RealtimeTransport {
  emit(businessId: string, event: RealtimeEvent): void;
}

let transport: RealtimeTransport | null = null;

/** Attach (or clear with `null`) the transport — only ./server.ts does this. */
export function setRealtimeTransport(next: RealtimeTransport | null): void {
  transport = next;
}

/** Publish an event. Never throws: a write must succeed without a socket. */
export function publishRealtime(event: RealtimeEvent): void {
  if (!transport) return;
  try {
    transport.emit(event.businessId, event);
  } catch (err) {
    logger.warn({ err, event: event.type }, "realtime publish failed");
  }
}

/** A stored message row became visible — publish it to the business. */
export function publishMessageCreated(
  businessId: string,
  message: {
    id: string;
    conversationId: string;
    sender: MessageSender;
    content: string;
    channel: ConversationChannel;
    aiGenerated: boolean;
    externalMessageId: string | null;
    createdAt: Date | string;
  },
): void {
  publishRealtime({
    type: "message.created",
    businessId,
    conversationId: message.conversationId,
    message: {
      id: message.id,
      conversationId: message.conversationId,
      sender: message.sender,
      content: message.content,
      channel: message.channel,
      aiGenerated: message.aiGenerated,
      externalMessageId: message.externalMessageId,
      createdAt:
        message.createdAt instanceof Date
          ? message.createdAt.toISOString()
          : message.createdAt,
    },
  });
}

/** A new thread appeared (dashboard list refresh signal). */
export function publishConversationCreated(
  businessId: string,
  conversationId: string,
): void {
  publishRealtime({ type: "conversation.created", businessId, conversationId });
}

/** Status/assignment changed — the thread header and filters must re-read. */
export function publishConversationUpdated(
  businessId: string,
  conversationId: string,
  status: ConversationStatus,
  assignedToId: string | null,
): void {
  publishRealtime({
    type: "conversation.updated",
    businessId,
    conversationId,
    status,
    assignedToId,
  });
}

/**
 * Someone started or stopped typing. Ephemeral UI state only — the client does
 * not refetch on it, so a dropped event simply clears itself when the state
 * expires (see ./typing.ts).
 */
export function publishTypingUpdated(
  businessId: string,
  conversationId: string,
  typing: TypingRoles,
): void {
  publishRealtime({
    type: "typing.updated",
    businessId,
    conversationId,
    typing,
  });
}

/** A booking appeared — an open calendar must re-read its range (§35). */
export function publishBookingCreated(
  businessId: string,
  booking: { id: string },
): void {
  publishRealtime({ type: "booking.created", businessId, bookingId: booking.id });
}

/** A booking was rescheduled or its status changed — the calendar re-reads. */
export function publishBookingUpdated(
  businessId: string,
  booking: { id: string; status: BookingStatus; startAt: Date | string; endAt: Date | string },
): void {
  publishRealtime({
    type: "booking.updated",
    businessId,
    bookingId: booking.id,
    status: booking.status,
    startAt:
      booking.startAt instanceof Date ? booking.startAt.toISOString() : booking.startAt,
    endAt: booking.endAt instanceof Date ? booking.endAt.toISOString() : booking.endAt,
  });
}
