import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

/**
 * One Prisma client per process, over the pg driver adapter (Prisma 7 no longer
 * takes the URL from schema.prisma).
 *
 * The pool is small on purpose. Growzar shares this box's Postgres with
 * Courierify, Preventify, Retainify and Inventorify, and the growzar_app role
 * is capped at 6 connections until max_connections goes 100 -> 130
 * (contracts/OPS-GROWZAR-SETUP.md step 1). Web takes 4, the worker takes 2.
 */
declare global {
  // eslint-disable-next-line no-var
  var __growzarPrisma: PrismaClient | undefined;
}

function createClient() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }

  const adapter = new PrismaPg({
    connectionString,
    max: Number(process.env.DATABASE_POOL ?? 4),
    connectionTimeoutMillis: 10_000,
  });

  return new PrismaClient({
    adapter,
    log:
      process.env.NODE_ENV === "production"
        ? ["warn", "error"]
        : ["query", "warn", "error"],
  });
}

export const prisma = global.__growzarPrisma ?? createClient();

if (process.env.NODE_ENV !== "production") {
  global.__growzarPrisma = prisma;
}
