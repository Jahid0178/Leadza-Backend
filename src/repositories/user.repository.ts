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

export async function createUser(input: RegisterInput, passwordHash: string): Promise<User> {
  return prisma.user.create({
    data: {
      email: input.email,
      name: input.name,
      passwordHash,
    },
  });
}
