import { data, redirect } from "react-router";

import type { Route } from "./+types/insights.$insightId.act";
import { prisma } from "~/lib/db.server";
import { requireStore } from "~/lib/authorize.server";
import { actionHref, isScreenKey } from "~/lib/apps/app-links";
import { clickSource } from "~/lib/insights/actions";
import { recordAct } from "~/lib/insights/inbox.server";

/**
 * A card's "set it up in the app" or "install the app" button (G-GZR6-2):
 * record it (kind `app_link`, with the screen and whether it was an install),
 * then leave for the app's admin screen or its App Store page.
 *
 * The destination is built here from a fixed list of screens and the store's
 * connections, never taken from the request, so this cannot be used to
 * redirect anywhere else.
 */
export async function loader({ request, params, url }: Route.LoaderArgs) {
  const screen = url.searchParams.get("screen");
  if (!isScreenKey(screen)) throw data("That link does not lead anywhere.", { status: 400 });
  const insight = await prisma.insight.findUnique({
    where: { id: params.insightId },
    select: { id: true, storeId: true, store: { select: { shopDomain: true } } },
  });
  if (!insight) throw data("That insight no longer exists.", { status: 404 });
  const { viewer } = await requireStore(request, insight.storeId, "home", "view");
  const connections = await prisma.appConnection.findMany({ where: { storeId: insight.storeId, status: "CONNECTED" }, select: { app: true } });
  const connected = new Set<string>(connections.map((c) => c.app));
  const href = actionHref(screen, connected, insight.store.shopDomain);
  // `from=digest`: the weekly email's button (G-GZR6-5).
  const from = clickSource(url.searchParams.get("from"));
  if (!href) throw data("There is no confirmed link for that app yet.", { status: 404 });
  // The first click or app link opens the insight's watch (G-GZR9-1).
  await recordAct(insight.id, insight.storeId, viewer.userId, "app_link", { screen, install: !href.includes("admin.shopify.com"), ...(from ? { from } : {}) });
  throw redirect(href);
}

export default function ActOnInsight() {
  return null;
}
