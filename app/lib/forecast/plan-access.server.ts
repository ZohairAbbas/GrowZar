import { viewerIsInternal } from "../outcomes/results.server";

/**
 * Who sees Plan (G-GZR11-6; pack §10, P11-13, P11-14): the kill switch
 * PLAN_ENABLED, read like Ask's, and until Zohair approves the forecasts and
 * the simulator, internal accounts only. The role check (plan:view) is the
 * caller's; money in Plan also needs finance:view.
 */
export const planEnabled = () => ["on", "true", "1"].includes((process.env.PLAN_ENABLED ?? "").trim().toLowerCase());

export async function planVisible(userId: string): Promise<boolean> {
  return planEnabled() && (await viewerIsInternal(userId));
}
