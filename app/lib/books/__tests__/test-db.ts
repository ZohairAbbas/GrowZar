/**
 * Books' database tests run in a private schema of growzar_shadow (D-91),
 * never in production's database: each suite creates `books_test_<pid>_<ms>`,
 * applies the Books migration to it with plain SQL (never the Prisma CLI), and
 * drops it after. Run with:
 *
 *   BOOKS_TEST_DATABASE_URL=$SHADOW_DATABASE_URL npx vitest run app/lib/books --no-file-parallelism
 *
 * growzar_app is capped at 6 connections and production's web and worker
 * share that cap, so a suite holds at most two (one per side of the
 * concurrency tests) and suites run one at a time.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";

export const TEST_DATABASE_URL = process.env.BOOKS_TEST_DATABASE_URL;

const MIGRATIONS = fileURLToPath(new URL("../../../../prisma/migrations/", import.meta.url));
/** Books' own tables: every `*_books_*` migration except the switch, which references organizations. */
const booksOnly = (n: string) => /^\d{14}_books_/.test(n) && n !== "20261022150000_books_settings";

/** The URL without its query string (Prisma-only parameters such as connection_limit upset pg). */
function baseUrl(url: string): string {
  return url.split("?")[0]!;
}

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: baseUrl(url) });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * Create the schema, apply the migration, and point `~/lib/db.server` at it.
 * Call before the first import of db.server. Returns a function that drops it.
 * `all`: every Growzar migration in order, for tests that also need stores,
 * ad spend or other Growzar tables (the connectors, B3).
 */
export async function openTestSchema(opts: { all?: boolean } = {}): Promise<() => Promise<void>> {
  const url = TEST_DATABASE_URL;
  if (!url) throw new Error("BOOKS_TEST_DATABASE_URL is not set");
  const schema = `books_test_${process.pid}_${Date.now()}`;
  await withClient(url, async (c) => {
    const { rows } = await c.query<{ db: string }>("SELECT current_database() AS db");
    const db = rows[0]!.db;
    if (!/shadow|scratch|test/.test(db)) throw new Error(`Refusing to run against database "${db}"`);
    await c.query(`CREATE SCHEMA "${schema}"`);
    await c.query(`SET search_path TO "${schema}"`);
    const names = readdirSync(MIGRATIONS).filter((n) => (opts.all ? /^\d{14}_/.test(n) : booksOnly(n))).sort();
    for (const n of names) await c.query(readFileSync(`${MIGRATIONS}${n}/migration.sql`, "utf8"));
  });
  // Prisma's generated queries name the schema; the raw SQL in the services
  // and the triggers' functions find it through search_path.
  const u = new URL(baseUrl(url));
  u.searchParams.set("options", `-c search_path=${schema}`);
  process.env.DATABASE_URL = u.toString();
  process.env.DATABASE_SCHEMA = schema;
  process.env.DATABASE_POOL = "2";
  // db.server keeps one client on globalThis outside production; a suite that ran
  // before this one in the same worker would otherwise hand over its client.
  delete (globalThis as { __growzarPrisma?: unknown }).__growzarPrisma;
  return () => withClient(url, (c) => c.query(`DROP SCHEMA "${schema}" CASCADE`).then(() => undefined));
}
