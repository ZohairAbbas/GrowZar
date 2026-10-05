import { Form, useNavigation } from "react-router";
import { AlertCircle, Check, Plus, Shield, X } from "lucide-react";

import type { Route } from "./+types/settings.roles";
import { auth } from "~/lib/auth.server";
import { readFormData } from "~/lib/form.server";
import { requireSection } from "~/lib/authorize.server";
import { readableAuthError } from "~/lib/session.server";
import {
  ACTIONS,
  ROLE_LABELS,
  SECTIONS,
  SECTION_LABELS,
  type Action,
  type RoleName,
  type Section,
} from "~/lib/permissions";
import { LoadingSpinner } from "~/components/ui/LoadingSpinner";
import { RoleBadge } from "~/components/ui/RoleBadge";

export function meta() {
  return [{ title: "Roles · Growzar" }];
}

/**
 * Custom roles (D-12): an organization builds its own section × action role
 * when the four built-in ones do not describe someone's job.
 *
 * The built-in four are shown but not editable. Changing what "staff" means
 * for one organization would change it for the code that reasons about staff
 * everywhere else; a new role is the honest way to express a different job.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const viewer = await requireSection(request, "settings", "manage");

  const customRoles = await auth.api.listOrgRoles({
    query: { organizationId: viewer.organizationId },
    headers: request.headers,
  });

  return {
    builtIn: (Object.keys(ROLE_LABELS) as RoleName[]).map((role) => ({
      name: role,
      label: ROLE_LABELS[role].label,
      description: ROLE_LABELS[role].description,
    })),
    customRoles: customRoles.map((role) => ({
      id: role.id,
      name: role.role,
      permissions: (role.permission ?? {}) as Record<string, string[]>,
    })),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const viewer = await requireSection(request, "settings", "manage");

  const formData = await readFormData(request);
  const intent = String(formData.get("intent") ?? "");

  try {
    if (intent === "delete") {
      await auth.api.deleteOrgRole({
        body: {
          roleName: String(formData.get("roleName") ?? ""),
          organizationId: viewer.organizationId,
        },
        headers: request.headers,
      });
      return { ok: "Role deleted." };
    }

    const name = String(formData.get("name") ?? "").trim().toLowerCase();

    if (!/^[a-z0-9-]{2,32}$/.test(name)) {
      return {
        error: "A role name is 2–32 lowercase letters, numbers or hyphens.",
      };
    }
    if (name in ROLE_LABELS) {
      return { error: `${name} is a built-in role and cannot be redefined.` };
    }

    // The matrix posts one checkbox per section:action pair.
    const permissions: Record<string, string[]> = {};
    for (const section of SECTIONS) {
      const granted = ACTIONS.filter((action) =>
        formData.has(`perm:${section}:${action}`),
      );
      if (granted.length > 0) {
        permissions[section] = granted;
      }
    }

    if (Object.keys(permissions).length === 0) {
      return { error: "Grant the role at least one thing to do." };
    }

    await auth.api.createOrgRole({
      body: {
        role: name,
        permission: permissions,
        organizationId: viewer.organizationId,
      },
      headers: request.headers,
    });

    return { ok: `Role ${name} created.` };
  } catch (error) {
    return { error: readableAuthError(error, "Could not save that role.") };
  }
}

function PermissionGrid({ permissions }: { permissions: Record<string, string[]> }) {
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full min-w-[420px] text-left text-sm">
        <thead>
          <tr className="text-xs uppercase tracking-wide text-gray-500">
            <th className="py-1.5 pr-4 font-medium">Section</th>
            {ACTIONS.map((action) => (
              <th key={action} className="px-2 py-1.5 text-center font-medium">
                {action}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {SECTIONS.map((section) => (
            <tr key={section}>
              <td className="py-1.5 pr-4 text-gray-700">
                {SECTION_LABELS[section]}
              </td>
              {ACTIONS.map((action) => {
                const granted = permissions[section]?.includes(action);
                return (
                  <td key={action} className="px-2 py-1.5 text-center">
                    {granted ? (
                      <Check className="mx-auto h-4 w-4 text-green-600" />
                    ) : (
                      <span className="text-gray-300">·</span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Roles({ loaderData, actionData }: Route.ComponentProps) {
  const navigation = useNavigation();
  const { builtIn, customRoles } = loaderData;
  const submittingIntent = navigation.formData?.get("intent")?.toString() ?? null;

  return (
    <div className="space-y-6">
      {actionData?.error ? (
        <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0" />
          <span>{actionData.error}</span>
        </div>
      ) : null}

      {actionData && "ok" in actionData && actionData.ok ? (
        <div className="flex items-center gap-2 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
          <Check className="h-5 w-5 flex-shrink-0" />
          <span>{actionData.ok}</span>
        </div>
      ) : null}

      <section className="rounded-2xl bg-white p-6">
        <h1 className="flex items-center gap-2 font-display text-lg font-bold text-gray-900">
          <Shield className="h-5 w-5 text-gray-400" />
          Roles
        </h1>
        <p className="mt-1 text-sm text-gray-600">
          A role says what someone may do. Which stores they may do it in is set
          per member, on the team screen.
        </p>

        <ul className="mt-5 space-y-2">
          {builtIn.map((role) => (
            <li
              key={role.name}
              className="flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 p-3"
            >
              <RoleBadge role={role.name} />
              <span className="min-w-0 flex-1 text-sm text-gray-600">
                {role.description}
              </span>
              <span className="text-xs font-medium uppercase tracking-wide text-gray-400">
                Built in
              </span>
            </li>
          ))}
        </ul>
      </section>

      {customRoles.length > 0 ? (
        <section className="rounded-2xl bg-white p-6">
          <h2 className="font-display text-lg font-bold text-gray-900">Your roles</h2>

          <ul className="mt-4 space-y-4">
            {customRoles.map((role) => (
              <li key={role.id} className="rounded-xl border border-gray-200 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <RoleBadge role={role.name} />
                  <Form method="post">
                    <input type="hidden" name="intent" value="delete" />
                    <input type="hidden" name="roleName" value={role.name} />
                    <button
                      type="submit"
                      className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-gray-500 transition hover:bg-red-50 hover:text-red-600"
                    >
                      <X className="h-3.5 w-3.5" />
                      Delete
                    </button>
                  </Form>
                </div>
                <PermissionGrid permissions={role.permissions} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="rounded-2xl bg-white p-6">
        <h2 className="font-display text-lg font-bold text-gray-900">Create a role</h2>
        <p className="mt-1 text-sm text-gray-600">
          Tick what the role may do. View shows a section, export takes its rows
          out, manage covers the actions that arrive after Phase 1.
        </p>

        <Form method="post" className="mt-5 space-y-5">
          <input type="hidden" name="intent" value="create" />

          <div className="max-w-xs">
            <label htmlFor="name" className="mb-2 block text-sm font-semibold text-gray-700">
              Role name
            </label>
            <input
              id="name"
              name="name"
              type="text"
              required
              pattern="[a-z0-9-]{2,32}"
              placeholder="packer"
              className="block h-12 w-full rounded-xl border border-gray-200 bg-gray-50 px-4 transition focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/20"
            />
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[420px] text-left text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-wide text-gray-500">
                  <th className="py-2 pr-4 font-medium">Section</th>
                  {ACTIONS.map((action) => (
                    <th key={action} className="px-2 py-2 text-center font-medium">
                      {action}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {SECTIONS.map((section: Section) => (
                  <tr key={section}>
                    <td className="py-2 pr-4 text-gray-700">
                      {SECTION_LABELS[section]}
                    </td>
                    {ACTIONS.map((action: Action) => (
                      <td key={action} className="px-2 py-2 text-center">
                        <input
                          type="checkbox"
                          name={`perm:${section}:${action}`}
                          aria-label={`${SECTION_LABELS[section]} ${action}`}
                          className="h-4 w-4"
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <button
            type="submit"
            disabled={navigation.state === "submitting"}
            className="flex h-11 items-center justify-center gap-2 rounded-full bg-primary-500 px-6 font-semibold text-white transition hover:bg-primary-600 disabled:opacity-50"
          >
            {submittingIntent === "create" ? (
              <LoadingSpinner size="sm" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
            <span>Create role</span>
          </button>
        </Form>
      </section>
    </div>
  );
}
