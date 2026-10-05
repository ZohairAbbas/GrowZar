import { data, redirect } from "react-router";

import type { Route } from "./+types/insights.$insightId.open";
import { prisma } from "~/lib/db.server";
import { requireStore } from "~/lib/authorize.server";
import { safeAppPath } from "~/lib/insights/actions";
import { recordClick } from "~/lib/insights/inbox.server";

/**
 * A card's "see the orders" link (G-GZR3-3): record the click (PLAN.md §9:
 * shown → clicked → changed), then go where the card pointed.
 *
 * Reads `url`, not `request.url`: a client-side navigation requests
 * `/insights/<id>/open.data?…`, and React Router normalises `url` for that.
 */
export async function loader({ request, params, url }: Route.LoaderArgs) {
  const to = safeAppPath(url.searchParams.get("to"));
  if (!to) throw data("That link does not lead anywhere in Growzar.", { status: 400 });
  const insight = await prisma.insight.findUnique({ where: { id: params.insightId }, select: { id: true, storeId: true } });
  if (!insight) throw redirect(to);
  const { viewer } = await requireStore(request, insight.storeId, "home", "view");
  await recordClick(insight.id, insight.storeId, viewer.userId, to);
  throw redirect(to);
}

/** Never rendered: the loader always redirects. It makes this a page route, so a <Link> navigates client-side. */
export default function OpenInsight() {
  return null;
}
