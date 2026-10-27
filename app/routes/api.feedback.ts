import { data } from "react-router";

import type { Route } from "./+types/api.feedback";
import { requireStore } from "~/lib/authorize.server";
import { readFormData } from "~/lib/form.server";
import { planEnabled } from "~/lib/forecast/plan-access.server";
import { riskVisible } from "~/lib/forecast/return-risk.server";
import { parseFeedback, SECTION_FOR } from "~/lib/feedback/product-feedback";
import { saveFeedback } from "~/lib/feedback/product-feedback.server";

/**
 * `POST /api/feedback`: "This looks wrong" on a Beta forecast or a return-risk
 * band (pre-Wave-1 pack 2). Only from a member who can see that tool on that
 * store: Plan's forecasts need plan:view and PLAN_ENABLED, a band needs
 * orders:view and return risk on for the store.
 */
export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const parsed = parseFeedback(await readFormData(request));
  if ("error" in parsed) return data({ error: parsed.error }, { status: 400 });
  const { viewer, store } = await requireStore(request, parsed.storeId, SECTION_FOR[parsed.tool]);
  const open = parsed.tool === "return_risk" ? await riskVisible(store.id) : planEnabled();
  if (!open) return data({ error: "This isn't available." }, { status: 404 });
  await saveFeedback(parsed, viewer);
  return { ok: true as const };
}

export function loader() {
  return new Response(null, { status: 405 });
}
