import { prisma } from "~/lib/db.server";
import { VERSION } from "~/lib/version.server";

/**
 * Readiness check. Returns 200 only when the database answers, so the monitor
 * catches a Postgres restart or an exhausted connection pool, not just a dead
 * process. Deliberately unauthenticated and free of any tenant data.
 */
export async function loader() {
  const startedAt = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return Response.json({
      ok: true,
      db: "up",
      latencyMs: Date.now() - startedAt,
      version: VERSION,
    });
  } catch (error) {
    console.error("[health] database check failed", error);
    return Response.json(
      { ok: false, db: "down", latencyMs: Date.now() - startedAt },
      { status: 503 },
    );
  }
}
