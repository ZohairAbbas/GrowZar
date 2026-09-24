import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements } from "better-auth/plugins/organization/access";

/**
 * Growzar's permission axis is **section × action** (D-12, D-20).
 *
 * The old hub's table was `resource:action` over `stores`, `analytics`,
 * `settings`, `members`, `billing`, `organization`
 * (`salvage/lib/rbac/permissions.ts`). That axis cannot express the case this
 * product exists for: a packer who may see Shipping but not Finance. So the
 * resources here are the nine navigation sections, and the old file is a shape
 * reference only — none of its rows are carried over.
 *
 * Store scope is deliberately NOT modelled here. A permission says *what* a
 * member may do; the store subset says *where*, it lives on the member row,
 * and both are checked together server-side (G-GZR-2).
 */
export const SECTIONS = [
  "home",
  "orders",
  "shipping",
  "finance",
  "customers",
  "inventory",
  "marketing",
  "inbox",
  "settings",
] as const;

export type Section = (typeof SECTIONS)[number];

/**
 * `view` reads a section, `export` takes the rows out of it (a separate grant
 * because a merchant's cost and margin data leaving the building is a
 * different decision from reading it on screen), `manage` covers the write
 * actions that arrive after Phase 1 — no write API ships in R1 (D-33), but the
 * grant exists so roles do not need re-cutting later.
 */
export const ACTIONS = ["view", "export", "manage"] as const;

export type Action = (typeof ACTIONS)[number];

const sectionStatements = Object.fromEntries(
  SECTIONS.map((section) => [section, ACTIONS]),
) as { [K in Section]: typeof ACTIONS };

/**
 * `defaultStatements` carries the organization plugin's own resources
 * (organization, member, invitation, team, ac). They must stay, or Better
 * Auth's built-in endpoints lose their checks.
 */
export const statement = {
  ...defaultStatements,
  ...sectionStatements,
} as const;

export const ac = createAccessControl(statement);

const allSections = Object.fromEntries(
  SECTIONS.map((section) => [section, [...ACTIONS]]),
) as { [K in Section]: Action[] };

const viewAndExport = (sections: Section[]) =>
  Object.fromEntries(sections.map((s) => [s, ["view", "export"] as Action[]]));

const viewOnly = (sections: Section[]) =>
  Object.fromEntries(sections.map((s) => [s, ["view"] as Action[]]));

/** Everything, including deleting the organization. One per organization. */
export const owner = ac.newRole({
  organization: ["update", "delete"],
  member: ["create", "update", "delete"],
  invitation: ["create", "cancel"],
  team: ["create", "update", "delete"],
  ac: ["create", "read", "update", "delete"],
  ...allSections,
});

/** Everything except deleting the organization. */
export const admin = ac.newRole({
  organization: ["update"],
  member: ["create", "update", "delete"],
  invitation: ["create", "cancel"],
  team: ["create", "update", "delete"],
  ac: ["create", "read", "update", "delete"],
  ...allSections,
});

/** Runs the day-to-day of the stores they are scoped to; no team or billing. */
export const manager = ac.newRole({
  member: [],
  invitation: ["create"],
  ...allSections,
  settings: ["view"],
});

/**
 * The packer case. Shipping and Orders to do the job, Home to see the day,
 * and nothing that reveals money.
 */
export const staff = ac.newRole({
  ...viewOnly(["home", "settings"]),
  ...viewAndExport(["orders", "shipping"]),
});

export const roles = { owner, admin, manager, staff };

export type RoleName = keyof typeof roles;

export const ROLE_NAMES = Object.keys(roles) as RoleName[];

/** What the invite form offers: everything except owner, which is transferred. */
export const INVITABLE_ROLES = ROLE_NAMES.filter((r) => r !== "owner");

export const ROLE_LABELS: Record<RoleName, { label: string; description: string }> = {
  owner: {
    label: "Owner",
    description: "Full access, including deleting the organization.",
  },
  admin: {
    label: "Admin",
    description: "Full access to every section and the team. Cannot delete the organization.",
  },
  manager: {
    label: "Manager",
    description: "Every section for their stores, and can invite. No team management.",
  },
  staff: {
    label: "Staff",
    description: "Orders and Shipping for their stores. No finance or customer data.",
  },
};

export const SECTION_LABELS: Record<Section, string> = {
  home: "Home",
  orders: "Orders",
  shipping: "Shipping",
  finance: "Finance",
  customers: "Customers",
  inventory: "Inventory",
  marketing: "Marketing",
  inbox: "Inbox",
  settings: "Settings",
};
