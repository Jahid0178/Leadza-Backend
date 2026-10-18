import "dotenv/config";
import { pathToFileURL } from "node:url";
import bcrypt from "bcryptjs";
import { prisma } from "../src/lib/prisma";

/**
 * Seed the default platform administrator (IMPLEMENTATION_PLAN step 28).
 *
 * Why a seed at all: the admin area is gated on `PLATFORM_ADMIN`, and until
 * now nothing in the product could create one — the flag had to be flipped by
 * hand in the database. This script makes that repeatable:
 *
 *   npm run db:seed          (or `npx prisma db seed`)
 *
 * Rules:
 *   - **Idempotent.** Re-running never duplicates the account and never
 *     rewrites an existing password, so a rotated credential survives a
 *     re-seed; it only re-asserts the admin role and an active status.
 *   - **Configurable.** ADMIN_EMAIL / ADMIN_PASSWORD / ADMIN_NAME override the
 *     development defaults below.
 *   - **Never the default password in production.** If NODE_ENV=production and
 *     ADMIN_PASSWORD was not set explicitly, the seed refuses to run: a
 *     well-known password for a platform administrator is a backdoor, and the
 *     email is public.
 *   - The password is hashed with the same cost the login path uses
 *     (auth.service.ts), and is never logged.
 */

/** Must match `SALT_ROUNDS` in src/services/auth.service.ts. */
const SALT_ROUNDS = 10;

const DEFAULT_EMAIL = "admin@leadza.com";
const DEFAULT_PASSWORD = "adminleadza26";
const DEFAULT_NAME = "Leadza Admin";

/** Minimum length we are willing to seed (mirrors registerSchema's floor). */
const MIN_PASSWORD_LENGTH = 8;

export interface SeedAdminResult {
  email: string;
  /** false when the account already existed (password left untouched). */
  created: boolean;
}

export interface SeedAdminOverrides {
  email?: string;
  password?: string;
  name?: string;
}

/**
 * Create or re-assert the platform administrator. Exported so it can be
 * exercised by tests; safe to call when the account already exists.
 */
export async function seedAdmin(
  overrides: SeedAdminOverrides = {},
): Promise<SeedAdminResult> {
  const email = (overrides.email ?? process.env.ADMIN_EMAIL ?? DEFAULT_EMAIL)
    .trim()
    .toLowerCase();
  const password = overrides.password ?? process.env.ADMIN_PASSWORD ?? DEFAULT_PASSWORD;
  const name = overrides.name ?? process.env.ADMIN_NAME ?? DEFAULT_NAME;

  const passwordWasProvided =
    overrides.password !== undefined || (process.env.ADMIN_PASSWORD ?? "") !== "";

  if (process.env.NODE_ENV === "production" && !passwordWasProvided) {
    throw new Error(
      "Refusing to seed the default administrator password in production. " +
        "Set ADMIN_PASSWORD to an explicit value and run the seed again.",
    );
  }

  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `The administrator password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    );
  }

  const existing = await prisma.user.findUnique({ where: { email } });

  if (existing) {
    // Re-assert the role and status, but leave the credential alone.
    const user = await prisma.user.update({
      where: { id: existing.id },
      data: {
        platformRole: "PLATFORM_ADMIN",
        status: "ACTIVE",
        emailVerified: existing.emailVerified ?? new Date(),
      },
    });
    return { email: user.email, created: false };
  }

  const user = await prisma.user.create({
    data: {
      email,
      name,
      passwordHash: await bcrypt.hash(password, SALT_ROUNDS),
      platformRole: "PLATFORM_ADMIN",
      status: "ACTIVE",
      // Administrators created by the seed are trusted; nothing should later
      // ask them to verify an address nobody sent them a link to.
      emailVerified: new Date(),
    },
  });

  return { email: user.email, created: true };
}

async function main(): Promise<void> {
  const result = await seedAdmin();

  console.log(
    `Platform administrator ${result.email} ${result.created ? "created" : "already exists (role re-asserted)"}.`,
  );

  if (!(process.env.ADMIN_PASSWORD ?? "")) {
    console.log(
      "Using the development default password. Set ADMIN_PASSWORD before seeding a real environment.",
    );
  }
}

// Only run when invoked directly (`npm run db:seed`), never on import — the
// test suite imports seedAdmin and must not touch the database at load time.
const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  main()
    .catch((error: unknown) => {
      console.error("Seed failed:", error instanceof Error ? error.message : error);
      process.exitCode = 1;
    })
    .finally(() => {
      void prisma.$disconnect();
    });
}
