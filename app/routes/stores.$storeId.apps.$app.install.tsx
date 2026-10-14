import { data, redirect } from "react-router";

import type { Route } from "./+types/stores.$storeId.apps.$app.install";
import { prisma } from "~/lib/db.server";
import { requireStore } from "~/lib/authorize.server";
import { SUITE_APPS, type LinkedApp } from "~/lib/apps/app-links";

/**
 * Home's "Next app for your store" button (G-GZR6-3): record the click, then
 * leave for the app's App Store page, or its admin home if the store has
 * connected it since the page loaded. The destination comes from the fixed
 * app list, never from the request.
 */
export async function loader({ request, params, url }: Route.LoaderArgs) {
  const app = params.app as LinkedApp;
  const entry = Object.hasOwn(SUITE_APPS, app) ? SUITE_APPS[app] : null;
  if (!entry) throw data("No such app.", { status: 404 });
  const { viewer } = await requireStore(request, params.storeId, "home", "view");
  const store = await prisma.store.findUniqueOrThrow({
    where: { id: params.storeId },
    select: { shopDomain: true, connections: { where: { app, status: "CONNECTED" }, select: { id: true } } },
  });
  const shop = store.shopDomain.replace(/\.myshopify\.com$/, "");
  const href =
    store.connections.length && entry.adminHandle && /^[a-z0-9][a-z0-9-]*$/.test(shop)
      ? `https://admin.shopify.com/store/${shop}/apps/${entry.adminHandle}/app`
      : entry.listing;
  if (!href) throw data("That app has no App Store page.", { status: 404 });
  await prisma.appPromptEvent.create({
    data: { storeId: params.storeId, app, kind: "clicked", userId: viewer.userId, detail: { lead: url.searchParams.get("lead") === "1" } },
  });
  throw redirect(href);
}

export default function InstallApp() {
  return null;
}
