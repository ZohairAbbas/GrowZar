import { data } from "react-router";

import type { Route } from "./+types/insights.$insightId";
import { prisma } from "~/lib/db.server";
import { requireStore } from "~/lib/authorize.server";
import { parseInsightAction } from "~/lib/insights/actions";
import { applyInsightAction } from "~/lib/insights/inbox.server";

/**
 * Dismiss (with a reason), snooze, or reopen an insight (G-GZR3-3). Posted
 * by a fetcher from Home, which then revalidates and the card goes.
 *
 * Acting on an insight is `home:manage`; the staff role can see Home but not
 * change what the organization's inbox shows. The store check is the same
 * one every store-scoped page uses, so an insight id from another
 * organization or outside the viewer's scope answers 403, like a store would.
 */
export async function action({ request, params }: Route.ActionArgs) {
  const insight = await prisma.insight.findUnique({ where: { id: params.insightId }, select: { id: true, storeId: true } });
  if (!insight) throw data("No such insight.", { status: 404 });
  const { viewer } = await requireStore(request, insight.storeId, "home", "manage");

  const act = parseInsightAction(await request.formData());
  if (!act) throw data("Unknown action.", { status: 400 });
  await applyInsightAction(insight.id, insight.storeId, viewer.userId, act);
  return { ok: true };
}
