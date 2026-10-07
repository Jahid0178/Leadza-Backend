import bcrypt from "bcryptjs";
import { ApiError } from "../utils/api-error";
import type { SessionUser } from "../auth/types";
import { createUser, findUserByEmail } from "../repositories/user.repository";
import type { RegisterInput } from "../validation/auth.schemas";

const SALT_ROUNDS = 10;

/** Compared against when the email is unknown, so timing doesn't reveal which accounts exist. */
const unknownUserHashPromise = bcrypt.hash("timing-equalization-placeholder", SALT_ROUNDS);

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

function toSessionUser(user: {
  id: string;
  email: string;
  name: string | null;
  platformRole: string;
}): SessionUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    platformRole: user.platformRole === "PLATFORM_ADMIN" ? "PLATFORM_ADMIN" : "USER",
  };
}

/** Creates a new user account. Throws ApiError with a safe message on conflict (§25). */
export async function registerUser(input: RegisterInput): Promise<SessionUser> {
  const passwordHash = await bcrypt.hash(input.password, SALT_ROUNDS);

  try {
    const user = await createUser(input, passwordHash);
    return toSessionUser(user);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw ApiError.conflict(
        "EMAIL_TAKEN",
        "An account with this email already exists. Try signing in instead.",
      );
    }
    throw error;
  }
}

/**
 * Verifies email + password. Returns the user or null — never reveals
 * whether the email exists (agent.md §41, authjs-skills best practice).
 */
export async function verifyCredentials(
  email: string,
  password: string,
): Promise<SessionUser | null> {
  const user = await findUserByEmail(email.toLowerCase());

  if (!user) {
    await bcrypt.compare(password, await unknownUserHashPromise);
    return null;
  }

  if (user.status !== "ACTIVE") return null;

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return null;

  return toSessionUser(user);
}
