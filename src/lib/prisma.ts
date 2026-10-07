import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client";
import { env } from "../config/env";

/**
 * The backend is the only application with database access (agent.md §12).
 * Prisma 7 requires a driver adapter (PrismaPg for PostgreSQL).
 */
const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });

export const prisma = new PrismaClient({ adapter });
