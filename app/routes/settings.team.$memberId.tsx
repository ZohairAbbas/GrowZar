import { Form, Link, useNavigation } from "react-router";
import { AlertCircle, ArrowLeft, Check, Shield, Store as StoreIcon } from "lucide-react";

import type { Route } from "./+types/settings.team.$memberId";
import { auth } from "~/lib/auth.server";
import { prisma } from "~/lib/db.server";
import { Forbidden, requireSection } from "~/lib/authorize.server";
import { readableAuthError } from "~/lib/session.server";
import { ROLE_LABELS, type RoleName } from "~/lib/permissions";
import { LoadingSpinner } from "~/components/ui/LoadingSpinner";
import { RoleBadge } from "~/components/ui/RoleBadge";

export function meta({ loaderData }: Route.MetaArgs) {
  return [
    {
      title: loaderData
        ? `${loaderData.member.name} · Team · Growzar`
        : "Team · Growzar",
    },
  ];
}

/**
 * Role and store scope for one member, set on one screen because they are one
 * decision: "what may this person do, and which shops may they do it to".
 *
 * Ported in spirit from salvage/components/settings/ChangeRoleModal.tsx, which
 * changed a role in a modal and had no concept of scope. A modal is the wrong
 * shape once there is a store list beside the role, so this is a page.
 */
export async function loader({ request, params }: Route.LoaderArgs) {
  const viewer = await requireSection(request, "settings", "manage");

  const member = await prisma.member.findFirst({
    where: { id: params.memberId, organizationId: viewer.organizationId },
    select: {
      id: true,
      role: true,
      scopeAllStores: true,
      user: { select: { name: true, email: true } },
      storeScopes: { select: { storeId: true } },
    },
  });

  if (!member) {
    throw new Forbidden("That member is not available to you.");
  }

  const [stores, customRoles] = await Promise.all([
    prisma.store.findMany({
      where: { organizationId: viewer.organizationId },
      orderBy: { shopDomain: "asc" },
      select: { id: true, shopDomain: true, displayName: true },
    }),
    auth.api.listOrgRoles({
      query: { organizationId: viewer.organizationId },
      headers: request.headers,
    }),
  ]);

  return {
    member: {
      id: member.id,
      name: member.user.name,
      email: member.user.email,
      role: member.role,
      scopeAllStores: member.scopeAllStores !== false,
      scopedStoreIds: member.storeScopes.map((scope) => scope.storeId),
    },
    stores,
    // Custom roles sit beside the four built-in ones (D-12).
    roleOptions: [
      ...(Object.keys(ROLE_LABELS) as RoleName[])
        .filter((role) => role !== "owner")
        .map((role) => ({
          name: role,
          label: ROLE_LABELS[role].label,
          description: ROLE_LABELS[role].description,
        })),
      ...customRoles.map((role) => ({
        name: role.role,
        label: role.role,
        description: "Custom role",
      })),
    ],
    viewerIsOwner: viewer.role === "owner",
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const viewer = await requireSection(request, "settings", "manage");

  const member = await prisma.member.findFirst({
    where: { id: params.memberId, organizationId: viewer.organizationId },
    select: { id: true, role: true },
  });

  if (!member) {
    throw new Forbidden("That member is not available to you.");
  }

  // Only an owner may touch another owner, and nobody demotes themselves by
  // accident: losing the last owner would leave the organization unmanageable.
  if (member.role === "owner" && viewer.role !== "owner") {
    throw new Forbidden("Only an owner can change an owner.");
  }

  const formData = await request.formData();
  const role = String(formData.get("role") ?? "").trim();
  const scopeAllStores = formData.get("scopeAllStores") === "all";
  const storeIds = formData.getAll("storeIds").map(String);

  if (!role) {
    return { error: "Choose a role." };
  }

  try {
    if (role !== member.role) {
      await auth.api.updateMemberRole({
        body: {
          memberId: member.id,
          role: role as "admin",
          organizationId: viewer.organizationId,
        },
        headers: request.headers,
      });
    }

    // Scope is rewritten wholesale rather than diffed: the form always posts
    // the complete set, and a partial update here would be a silent way to
    // leave a store behind.
    const storesInOrg = scopeAllStores
      ? []
      : await prisma.store.findMany({
          where: { id: { in: storeIds }, organizationId: viewer.organizationId },
          select: { id: true },
        });

    await prisma.$transaction([
      prisma.member.update({
        where: { id: member.id },
        data: { scopeAllStores },
      }),
      prisma.memberStoreScope.deleteMany({ where: { memberId: member.id } }),
      prisma.memberStoreScope.createMany({
        data: storesInOrg.map((store) => ({
          memberId: member.id,
          storeId: store.id,
        })),
      }),
    ]);

    return { ok: true as const };
  } catch (error) {
    return { error: readableAuthError(error, "Could not save that member.") };
  }
}

export default function MemberSettings({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const navigation = useNavigation();
  const { member, stores, roleOptions } = loaderData;

  return (
    <div className="space-y-6">
      <Link
        to="/settings/team"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-500 transition hover:text-gray-900"
      >
        <ArrowLeft className="h-4 w-4" />
        Team
      </Link>

      <section className="rounded-2xl border border-gray-200 bg-white p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold text-gray-900">
              {member.name}
            </h1>
            <p className="truncate text-sm text-gray-600">{member.email}</p>
          </div>
          <RoleBadge role={member.role} />
        </div>

        <Form method="post" className="mt-6 space-y-7">
          {actionData?.error ? (
            <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0" />
              <span>{actionData.error}</span>
            </div>
          ) : null}

          {actionData && "ok" in actionData && actionData.ok ? (
            <div className="flex items-center gap-2 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
              <Check className="h-5 w-5 flex-shrink-0" />
              <span>Saved.</span>
            </div>
          ) : null}

          <fieldset>
            <legend className="flex items-center gap-2 text-sm font-semibold text-gray-900">
              <Shield className="h-4 w-4 text-gray-400" />
              Role
            </legend>
            <p className="mt-1 text-sm text-gray-600">
              What they may do, in every store they can reach.
            </p>

            <div className="mt-3 space-y-2">
              {roleOptions.map((option) => (
                <label
                  key={option.name}
                  className="flex cursor-pointer items-start gap-3 rounded-xl border border-gray-200 p-3 transition hover:bg-gray-50 has-[:checked]:border-accent-500 has-[:checked]:bg-accent-50"
                >
                  <input
                    type="radio"
                    name="role"
                    value={option.name}
                    defaultChecked={member.role === option.name}
                    className="mt-1 h-4 w-4"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-gray-900">
                      {option.label}
                    </span>
                    <span className="block text-xs text-gray-500">
                      {option.description}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset>
            <legend className="flex items-center gap-2 text-sm font-semibold text-gray-900">
              <StoreIcon className="h-4 w-4 text-gray-400" />
              Store access
            </legend>
            <p className="mt-1 text-sm text-gray-600">
              Where that role applies. A store left unticked returns 403, not a
              rendered page.
            </p>

            <div className="mt-3 space-y-2">
              <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-gray-200 p-3 transition hover:bg-gray-50 has-[:checked]:border-accent-500 has-[:checked]:bg-accent-50">
                <input
                  type="radio"
                  name="scopeAllStores"
                  value="all"
                  defaultChecked={member.scopeAllStores}
                  className="h-4 w-4"
                />
                <span className="text-sm font-medium text-gray-900">
                  Every store, including ones connected later
                </span>
              </label>

              <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-gray-200 p-3 transition hover:bg-gray-50 has-[:checked]:border-accent-500 has-[:checked]:bg-accent-50">
                <input
                  type="radio"
                  name="scopeAllStores"
                  value="subset"
                  defaultChecked={!member.scopeAllStores}
                  className="h-4 w-4"
                />
                <span className="text-sm font-medium text-gray-900">
                  Only the stores ticked below
                </span>
              </label>
            </div>

            {stores.length === 0 ? (
              <p className="mt-3 text-sm text-gray-500">
                No stores connected yet, so there is nothing to narrow to.
              </p>
            ) : (
              <div className="mt-3 space-y-1.5 rounded-xl border border-gray-200 p-3">
                {stores.map((store) => (
                  <label
                    key={store.id}
                    className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 transition hover:bg-gray-50"
                  >
                    <input
                      type="checkbox"
                      name="storeIds"
                      value={store.id}
                      defaultChecked={member.scopedStoreIds.includes(store.id)}
                      className="h-4 w-4"
                    />
                    <span className="min-w-0">
                      <span className="block truncate text-sm text-gray-900">
                        {store.displayName ?? store.shopDomain}
                      </span>
                      <span className="block truncate text-xs text-gray-500">
                        {store.shopDomain}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            )}
          </fieldset>

          <button
            type="submit"
            disabled={navigation.state === "submitting"}
            className="flex h-11 items-center justify-center gap-2 rounded-xl bg-primary-500 px-6 font-semibold text-white transition hover:bg-primary-600 disabled:opacity-50"
          >
            {navigation.state === "submitting" ? <LoadingSpinner size="sm" /> : null}
            <span>Save</span>
          </button>
        </Form>
      </section>
    </div>
  );
}
