import type { Route } from "./+types/api.push.click";
import { getSession } from "~/lib/session.server";
import { recordPushClick } from "~/lib/push/push.server";

/**
 * `POST /api/push/click`: the service worker reports a click on a push
 * (pre-Wave-1 pack 4), so a push's clicks count as the digest's do. Signed in
 * as the member it went to, or nothing is recorded; 204 either way.
 */
export async function action({ request }: Route.ActionArgs) {
  const session = await getSession(request).catch(() => null);
  if (!session) return new Response(null, { status: 204 });
  const id = String((await request.formData().catch(() => null))?.get("id") ?? "");
  if (/^[0-9a-f-]{36}$/.test(id)) await recordPushClick(id, session.user.id);
  return new Response(null, { status: 204 });
}

export function loader() {
  return new Response(null, { status: 405 });
}
