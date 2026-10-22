import { describe, expect, it } from "vitest";

import { ACTIONS, SECTIONS, roles } from "./permissions";

/**
 * The role table is the thing a mistake is quietest in: a wrong entry does not
 * throw, it just shows a packer the margin on every order. So the cases here
 * are the ones a person would actually be harmed by, stated as such.
 */
const can = (role: keyof typeof roles, section: string, action: string) =>
  roles[role].authorize({ [section]: [action] }).success;

describe("section × action roles", () => {
  it("covers every section for every action", () => {
    for (const section of SECTIONS) {
      for (const action of ACTIONS) {
        expect(can("owner", section, action), `owner ${section}:${action}`).toBe(
          true,
        );
      }
    }
  });

  it("keeps staff out of money and customer data", () => {
    // The packer case from the pack: Shipping yes, Finance no.
    expect(can("staff", "shipping", "view")).toBe(true);
    expect(can("staff", "orders", "view")).toBe(true);

    expect(can("staff", "finance", "view")).toBe(false);
    expect(can("staff", "customers", "view")).toBe(false);
    expect(can("staff", "marketing", "view")).toBe(false);
    expect(can("staff", "inventory", "view")).toBe(false);
  });

  it("does not let staff change anything, even where they can look", () => {
    expect(can("staff", "shipping", "manage")).toBe(false);
    expect(can("staff", "orders", "manage")).toBe(false);
    expect(can("staff", "settings", "manage")).toBe(false);
  });

  it("stops admin short of deleting the organization", () => {
    expect(can("admin", "finance", "manage")).toBe(true);
    expect(roles.admin.authorize({ organization: ["update"] }).success).toBe(true);
    expect(roles.admin.authorize({ organization: ["delete"] }).success).toBe(
      false,
    );
    expect(roles.owner.authorize({ organization: ["delete"] }).success).toBe(
      true,
    );
  });

  it("gives a manager the stores but not the team", () => {
    expect(can("manager", "finance", "view")).toBe(true);
    expect(can("manager", "finance", "export")).toBe(true);
    expect(can("manager", "settings", "manage")).toBe(false);
    expect(roles.manager.authorize({ member: ["create"] }).success).toBe(false);
    expect(roles.manager.authorize({ invitation: ["create"] }).success).toBe(
      true,
    );
  });

  it("gives Books to owners and admins, read-only to managers, none to staff (D-80)", () => {
    expect(can("owner", "books", "manage")).toBe(true);
    expect(can("admin", "books", "manage")).toBe(true);
    expect(can("manager", "books", "view")).toBe(true);
    expect(can("manager", "books", "export")).toBe(true);
    expect(can("manager", "books", "manage")).toBe(false);
    expect(can("staff", "books", "view")).toBe(false);
  });

  it("keeps the accountant to Books and Finance (D-70)", () => {
    expect(can("accountant", "books", "manage")).toBe(true);
    expect(can("accountant", "finance", "view")).toBe(true);
    expect(can("accountant", "finance", "export")).toBe(true);
    expect(can("accountant", "finance", "manage")).toBe(false);
    for (const section of ["home", "orders", "shipping", "plan", "customers", "inventory", "marketing", "inbox", "settings"]) {
      expect(can("accountant", section, "view"), section).toBe(false);
    }
    expect(roles.accountant.authorize({ member: ["create"] }).success).toBe(false);
    expect(roles.accountant.authorize({ invitation: ["create"] }).success).toBe(false);
  });
});
