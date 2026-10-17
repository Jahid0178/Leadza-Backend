import { publishTypingUpdated, type TypingRoles } from "./hub";

/**
 * "Who is typing" state (FEATURES §22, §32).
 *
 * Typing is deliberately ephemeral: it is not stored, it is not part of a
 * message, and losing it is harmless. Each role's flag is a timestamp that
 * simply expires, so a browser that closes mid-sentence can never leave a
 * permanent "typing…" bubble behind — the next read prunes it.
 *
 * Kept in-process, next to the socket transport (./server.ts): both live in
 * one Node process for the MVP, so a registry on a broker would be premature.
 */

export type TypingRole = keyof TypingRoles;

/** How long a "typing" signal stays true without being renewed. */
export const TYPING_TTL_MS = 8000;

/** conversationId → role → expiry timestamp (epoch ms). */
const active = new Map<string, Map<TypingRole, number>>();

/** Drop expired flags for one conversation and return what is left. */
function prune(
  conversationId: string,
  now: number,
): Map<TypingRole, number> {
  const roles = active.get(conversationId);
  if (!roles) return new Map();
  for (const [role, expiresAt] of roles) {
    if (expiresAt <= now) roles.delete(role);
  }
  if (roles.size === 0) active.delete(conversationId);
  return roles;
}

/** The current flags for a conversation, as booleans. */
export function typingState(
  conversationId: string,
  now: number = Date.now(),
): TypingRoles {
  const roles = prune(conversationId, now);
  return {
    CUSTOMER: roles.has("CUSTOMER"),
    HUMAN: roles.has("HUMAN"),
    AI: roles.has("AI"),
  };
}

/** Mark a role as typing for `ttlMs` and announce the new state. */
export function setTyping(
  businessId: string,
  conversationId: string,
  role: TypingRole,
  ttlMs: number = TYPING_TTL_MS,
): void {
  const roles = active.get(conversationId) ?? new Map<TypingRole, number>();
  roles.set(role, Date.now() + ttlMs);
  active.set(conversationId, roles);
  publishTypingUpdated(businessId, conversationId, typingState(conversationId));
}

/** Stop a role typing. A no-op (no event) when it was not typing. */
export function clearTyping(
  businessId: string,
  conversationId: string,
  role: TypingRole,
): void {
  const roles = active.get(conversationId);
  if (!roles || !roles.has(role)) return;
  roles.delete(role);
  if (roles.size === 0) active.delete(conversationId);
  publishTypingUpdated(businessId, conversationId, typingState(conversationId));
}

/** Forget every conversation — used by tests. */
export function resetTyping(): void {
  active.clear();
}
