import type { Route } from "./+types/api.client-error";
import { getSession } from "~/lib/session.server";

/**
 * `POST /api/client-error`: a browser crash, written to the web log with who
 * hit it. Signed-in members only, small bodies only; answers 204 either way
 * and never echoes anything back.
 */
export async function action({ request }: Route.ActionArgs) {
  const session = await getSession(request).catch(() => null);
  if (!session) return new Response(null, { status: 204 });
  const text = (await request.text().catch(() => "")).slice(0, 10_000);
  let report: Record<string, unknown> = {};
  try {
    report = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return new Response(null, { status: 204 });
  }
  const s = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : "");
  console.error(`[client-error] user=${session.user.id} url=${s(report.url, 300)} ua=${s(report.userAgent, 300)}\n${s(report.message, 2_000)}\n${s(report.stack, 6_000)}`);
  return new Response(null, { status: 204 });
}

export function loader() {
  return new Response(null, { status: 405 });
}
