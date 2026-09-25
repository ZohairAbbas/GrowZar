import { redirect } from "react-router";

import type { Route } from "./+types/switch";
import { auth } from "~/lib/auth.server";
import { prisma } from "~/lib/db.server";
import { getViewer, listVisibleStores } from "~/lib/authorize.server";
import { redirectWithCookies } from "~/lib/session.server";
import { safeRedirectPath } from "~/lib/redirects";

/**
 * Switching organization or store, for the shell's two switchers.
 *
 * A resource route rather than the shell layout's own action: a form inside a
 * pathless layout posts to the matched leaf route, not to the layout, so the
 * layout's action would never run.
 */
export const STORE_COOKIE = "growzar_store";

const STORE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export async function action({ request }: Route.ActionArgs) {
  const viewer = await getViewer(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const back = safeRedirectPath(formData.get("returnTo"), "/home");

  if (intent === "switch-organization") {
    const organizationId = String(formData.get("organizationId") ?? "");

    // Re-checked against the database. The id arrives from a form, and a form
    // is not a permission.
    const membership = await prisma.member.findFirst({
      where: { organizationId, userId: viewer.userId },
      select: { id: true },
    });
    if (!membership) {
      throw new Response("Not a member of that organization.", { status: 403 });
    }

    const activated = await auth.api.setActiveOrganization({
      body: { organizationId },
      headers: request.headers,
      asResponse: true,
    });

    // The remembered store belongs to the organization being left, so it is
    // cleared rather than carried across.
    const response = redirectWithCookies(activated, "/home");
    response.headers.append(
      "Set-Cookie",
      `${STORE_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly`,
    );
    return response;
  }

  if (intent === "switch-store") {
    const storeId = String(formData.get("storeId") ?? "");

    // Only a store this member may actually see can be remembered — scope is
    // checked here, not trusted from the page that rendered the list.
    const visible = await listVisibleStores(viewer);
    if (!visible.some((store) => store.id === storeId)) {
      throw new Response("That store is not available to you.", { status: 403 });
    }

    return redirect(back, {
      headers: {
        "Set-Cookie": `${STORE_COOKIE}=${encodeURIComponent(storeId)}; Path=/; Max-Age=${STORE_COOKIE_MAX_AGE}; SameSite=Lax; HttpOnly`,
      },
    });
  }

  throw new Response("Unknown action.", { status: 400 });
}

export function loader() {
  return redirect("/home");
}
