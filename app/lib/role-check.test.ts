import { describe, expect, it, vi } from "vitest";

const customRoles: Array<{ role: string; permission: string }> = [];
vi.mock("./db.server", () => ({ prisma: { organizationRole: { findMany: async () => customRoles } } }));

const { roleChecker } = await import("./role-check.server");

describe("roleChecker", () => {
  it("answers the built-in roles as Better Auth does", async () => {
    const can = await roleChecker("org");
    expect(can("owner", "finance", "view")).toBe(true);
    expect(can("manager", "home", "view")).toBe(true);
    expect(can("staff", "home", "view")).toBe(true);
    // The packer case: Home without money.
    expect(can("staff", "finance", "view")).toBe(false);
  });

  it("reads an organization's custom roles, merged over a built-in of the same name", async () => {
    customRoles.splice(0, customRoles.length,
      { role: "accountant", permission: JSON.stringify({ home: ["view"], finance: ["view"] }) },
      { role: "staff", permission: JSON.stringify({ finance: ["view"] }) },
    );
    const can = await roleChecker("org");
    expect(can("accountant", "finance", "view")).toBe(true);
    expect(can("accountant", "orders", "view")).toBe(false);
    expect(can("staff", "finance", "view")).toBe(true);
    expect(can("staff", "shipping", "view")).toBe(true);
  });

  it("gives a member with several roles the union, and an unknown or unreadable role nothing", async () => {
    customRoles.splice(0, customRoles.length, { role: "broken", permission: "{not json" });
    const can = await roleChecker("org");
    expect(can("staff,manager", "finance", "view")).toBe(true);
    expect(can("nobody", "home", "view")).toBe(false);
    expect(can("broken", "home", "view")).toBe(false);
  });
});
