import { prisma } from "./db.server";
import { ac, roles, type Action, type Section } from "./permissions";

type Role = ReturnType<typeof ac.newRole>;

/**
 * Does a member's role grant `section:action`, asked without a signed-in
 * request? The weekly digest (G-GZR6-5) is built in the worker, where there
 * is no session for Better Auth's `hasPermission` to read, so this repeats
 * what that check does (better-auth 1.7.5, organization/has-permission.mjs):
 * an organization's custom roles are merged over the built-in ones of the
 * same name, and a member holding several roles ("a,b") has the union.
 *
 * Loaded once per organization; the returned function does no I/O.
 */
export async function roleChecker(organizationId: string): Promise<(role: string, section: Section, action: Action) => boolean> {
  const acRoles: Record<string, Role> = { ...roles };
  const custom = await prisma.organizationRole.findMany({ where: { organizationId }, select: { role: true, permission: true } });
  for (const { role, permission } of custom) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(permission);
    } catch {
      parsed = null;
    }
    if (!isStatements(parsed)) {
      // Better Auth refuses the whole check here; granting nothing is the same answer.
      console.error(`[roles] organization ${organizationId}: role ${role} has unreadable permissions`);
      delete acRoles[role];
      continue;
    }
    const merged: Record<string, string[]> = { ...(acRoles[role]?.statements as Record<string, string[]> | undefined) };
    for (const [key, actions] of Object.entries(parsed)) merged[key] = [...new Set([...(merged[key] ?? []), ...actions])];
    acRoles[role] = ac.newRole(merged as Parameters<typeof ac.newRole>[0]);
  }
  return (role, section, action) => role.split(",").some((r) => acRoles[r]?.authorize({ [section]: [action] }).success === true);
}

const isStatements = (v: unknown): v is Record<string, string[]> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.values(v).every((a) => Array.isArray(a) && a.every((x) => typeof x === "string"));
