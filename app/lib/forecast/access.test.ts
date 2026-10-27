import { afterEach, describe, expect, it, vi } from "vitest";

import { admin, manager, owner, staff } from "../permissions";

/**
 * Who sees Plan and return risk once they open to every organization
 * (pre-Wave-1 pack 2): any member whose role allows it, in an ordinary
 * organization, and nobody at all with the switch off.
 */

let courierify = true;
vi.mock("../db.server", () => ({
  prisma: {
    appConnection: { findFirst: async () => (courierify ? { app: "COURIERIFY" } : null) },
  },
}));

const { planVisible } = await import("./plan-access.server");
const { riskVisible } = await import("./return-risk.server");

const ROLES = { owner, admin, manager, staff };
const canPlan = (role: keyof typeof ROLES) => ROLES[role].authorize({ plan: ["view"] }).success;
const canOrders = (role: keyof typeof ROLES) => ROLES[role].authorize({ orders: ["view"] }).success;

afterEach(() => {
  vi.unstubAllEnvs();
  courierify = true;
});

describe("Plan for an ordinary organization", () => {
  it("shows to owners, admins and managers, not staff, while PLAN_ENABLED is on", () => {
    vi.stubEnv("PLAN_ENABLED", "on");
    expect((["owner", "admin", "manager", "staff"] as const).map((r) => planVisible(canPlan(r)))).toEqual([true, true, true, false]);
  });

  it("shows to nobody with the switch off or unset", () => {
    for (const v of ["off", "", "no"]) {
      vi.stubEnv("PLAN_ENABLED", v);
      expect((["owner", "manager", "staff"] as const).map((r) => planVisible(canPlan(r))), v).toEqual([false, false, false]);
    }
  });
});

describe("return risk for an ordinary organization", () => {
  it("shows on a store with Courierify to every role that sees Orders, while RETURN_RISK_ENABLED is on", async () => {
    vi.stubEnv("RETURN_RISK_ENABLED", "on");
    expect(await riskVisible("any-store")).toBe(true);
    // The band sits in the Orders table, which owner, manager and staff all open.
    expect((["owner", "manager", "staff"] as const).map(canOrders)).toEqual([true, true, true]);
  });

  it("does not show without Courierify", async () => {
    vi.stubEnv("RETURN_RISK_ENABLED", "on");
    courierify = false;
    expect(await riskVisible("any-store")).toBe(false);
  });

  it("shows to nobody with the switch off", async () => {
    vi.stubEnv("RETURN_RISK_ENABLED", "off");
    expect(await riskVisible("any-store")).toBe(false);
  });
});
