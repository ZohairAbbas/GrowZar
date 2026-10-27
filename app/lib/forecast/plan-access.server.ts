/**
 * Who sees Plan (G-GZR11-6; pre-Wave-1 pack 2, 2026-10-27): every member
 * whose role has plan:view, in every organization, while the kill switch
 * PLAN_ENABLED is on. With it off, nobody sees Plan, internal or not. The
 * role check is the caller's; money in Plan also needs finance:view.
 */
export const planEnabled = () => ["on", "true", "1"].includes((process.env.PLAN_ENABLED ?? "").trim().toLowerCase());

/** Whether a member with this role sees Plan. */
export const planVisible = (canPlan: boolean): boolean => canPlan && planEnabled();
