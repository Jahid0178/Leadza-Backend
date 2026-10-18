import type { User } from "../../generated/prisma/client";
import { prisma } from "../lib/prisma";
import type { RegisterInput } from "../validation/auth.schemas";

/**
 * Database access lives in repositories (agent.md §11).
 * Only the backend ever touches the database (§12).
 */
export async function findUserByEmail(email: string): Promise<User | null> {
  return prisma.user.findUnique({ where: { email } });
}

export async function findUserById(id: string): Promise<User | null> {
  return prisma.user.findUnique({ where: { id } });
}

/**
 * The authoritative account state for an authenticated request
 * (IMPLEMENTATION_PLAN step 28).
 *
 * The session JWT carries `platformRole` from the moment it was issued and
 * lives for 30 days, so a demoted or suspended administrator would otherwise
 * keep their access until they signed in again (§5, §43). The admin gate
 * re-reads this row instead, which makes a role change or suspension take
 * effect on the very next request.
 */
export async function findUserAuthState(id: string): Promise<{
  id: string;
  platformRole: string;
  status: string;
} | null> {
  return prisma.user.findUnique({
    where: { id },
    select: { id: true, platformRole: true, status: true },
  });
}

export async function createUser(input: RegisterInput, passwordHash: string): Promise<User> {
  return prisma.user.create({
    data: {
      email: input.email,
      name: input.name,
      passwordHash,
    },
  });
}
