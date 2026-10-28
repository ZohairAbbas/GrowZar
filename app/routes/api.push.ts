import { data } from "react-router";

import type { Route } from "./+types/api.push";
import { getViewer } from "~/lib/authorize.server";
import { prisma } from "~/lib/db.server";
import { readFormData } from "~/lib/form.server";
import { requireOrganization } from "~/lib/session.server";
import { parseSubscription, pushSettingFor, removeSubscription, saveSubscription, sendTestPush } from "~/lib/push/push.server";

/**
 * `POST /api/push`: Settings' Notifications switch (pre-Wave-1 pack 4).
 * `subscribe` keeps this device for the member, `unsubscribe` drops it, and
 * `test` sends one to their own devices. Refused while the switch would not
 * show to this member (keys missing, or sending not yet open to them).
 */
export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const { session } = await requireOrganization(request);
  const viewer = await getViewer(request);
  if (!pushSettingFor(session.user.email).visible) return data({ error: "Notifications aren't available yet." }, { status: 404 });

  const form = await readFormData(request);
  const intent = String(form.get("intent") ?? "");
  if (intent === "subscribe") {
    const sub = parseSubscription(String(form.get("subscription") ?? ""));
    if (!sub) return data({ error: "That isn't a browser subscription." }, { status: 400 });
    await saveSubscription(viewer.memberId, sub, request.headers.get("user-agent"), form.get("replaces") ? String(form.get("replaces")) : null);
    return { ok: true as const };
  }
  if (intent === "unsubscribe") {
    await removeSubscription(viewer.memberId, String(form.get("endpoint") ?? ""));
    return { ok: true as const };
  }
  if (intent === "test") {
    // The member's day for the log, as the run counts it: their first store's timezone.
    const store = await prisma.store.findFirst({
      where: { organizationId: viewer.organizationId, ...(viewer.scopedStoreIds ? { id: { in: viewer.scopedStoreIds } } : {}) },
      select: { timezone: true },
      orderBy: { shopDomain: "asc" },
    });
    return { ok: true as const, test: await sendTestPush(viewer, store?.timezone ?? "UTC") };
  }
  return data({ error: "Unknown request." }, { status: 400 });
}

export function loader() {
  return new Response(null, { status: 405 });
}
