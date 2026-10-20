import { prisma } from "../db.server";
import { getViewer, listVisibleStores } from "../authorize.server";
import { roleChecker } from "../role-check.server";
import { planVisible } from "../forecast/plan-access.server";
import { returnRiskEnabled, riskOrgs } from "../forecast/return-risk.server";
import { viewerIsInternal } from "../outcomes/results.server";
import type { AskContext } from "./types";

/**
 * Who is asking and where they may look, resolved once per question from the
 * signed-in session: the stores come from `listVisibleStores` (scope, D-20)
 * and the sections from the role, exactly as the screens check them. The
 * model never supplies either.
 */
export async function askContext(request: Request, now = new Date()): Promise<AskContext> {
  const viewer = await getViewer(request);
  const [stores, can, org] = await Promise.all([
    listVisibleStores(viewer),
    roleChecker(viewer.organizationId),
    prisma.organization.findUniqueOrThrow({ where: { id: viewer.organizationId }, select: { baseCurrency: true } }),
  ]);
  const internal = await viewerIsInternal(viewer.userId);
  return {
    planTools: can(viewer.role, "plan", "view") && (await planVisible(viewer.userId)),
    riskTools: returnRiskEnabled() && (internal || riskOrgs().has(viewer.organizationId)),
    organizationId: viewer.organizationId,
    userId: viewer.userId,
    baseCurrency: org.baseCurrency,
    stores: stores.map((s) => ({ id: s.id, name: s.displayName ?? s.shopDomain, currency: s.currency, timezone: s.timezone })),
    can: (section) => can(viewer.role, section, "view"),
    now,
    memo: new Map(),
  };
}
