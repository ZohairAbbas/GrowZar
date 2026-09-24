import { Form, redirect, useNavigation } from "react-router";
import { AlertCircle, Building2, Check, Trash2 } from "lucide-react";

import type { Route } from "./+types/settings.organization";
import { auth } from "~/lib/auth.server";
import { Forbidden, can, requireSection } from "~/lib/authorize.server";
import { readableAuthError } from "~/lib/session.server";
import { LoadingSpinner } from "~/components/ui/LoadingSpinner";
import { RoleBadge } from "~/components/ui/RoleBadge";

export function meta() {
  return [{ title: "Organization · Growzar" }];
}

const CURRENCIES = ["PKR", "USD", "AED", "SAR", "GBP", "EUR"];

/**
 * Ported from salvage/components/settings/OrganizationDetailsForm.tsx and
 * DangerZone.tsx, merged into one screen. Both were client components posting
 * to hub API routes; the loader and action replace all of it.
 *
 * The permission checks are Better Auth's own for now — `organization:update`
 * and `organization:delete` from the role table in app/lib/permissions.ts.
 * G-GZR-2 adds the section-level check and the store scope on top.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const viewer = await requireSection(request, "settings", "view");
  const organizationId = viewer.organizationId;

  const organization = await auth.api.getFullOrganization({
    query: { organizationId },
    headers: request.headers,
  });

  const [canEdit, canDelete] = await Promise.all([
    can(request, organizationId, { organization: ["update"] }),
    can(request, organizationId, { organization: ["delete"] }),
  ]);

  return {
    canEdit,
    canDelete,
    organization: {
      id: organization!.id,
      name: organization!.name,
      slug: organization!.slug,
      baseCurrency: (organization as { baseCurrency?: string }).baseCurrency ?? "",
      memberCount: organization!.members.length,
    },
    viewerRole: viewer.role,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const viewer = await requireSection(request, "settings", "view");
  const organizationId = viewer.organizationId;
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "delete") {
    // Re-checked here, not inferred from the loader: the delete form can be
    // posted without ever rendering the page that hides it.
    if (!(await can(request, organizationId, { organization: ["delete"] }))) {
      throw new Forbidden("Only an owner can delete the organization.");
    }

    const typed = String(formData.get("confirmSlug") ?? "").trim().toLowerCase();
    const expected = String(formData.get("slug") ?? "").trim().toLowerCase();

    if (!typed || typed !== expected) {
      return { error: `Type ${expected} exactly to confirm.` };
    }

    try {
      await auth.api.deleteOrganization({
        body: { organizationId },
        headers: request.headers,
      });
      throw redirect("/organizations/new");
    } catch (error) {
      if (error instanceof Response) throw error;
      return {
        error: readableAuthError(error, "Could not delete the organization."),
      };
    }
  }

  if (!(await can(request, organizationId, { organization: ["update"] }))) {
    throw new Forbidden("Your role does not allow changing the organization.");
  }

  const name = String(formData.get("name") ?? "").trim();
  const slug = String(formData.get("slug") ?? "").trim().toLowerCase();
  const baseCurrency = String(formData.get("baseCurrency") ?? "").toUpperCase();

  if (!name || !slug) {
    return { error: "A name and a slug are both required." };
  }
  if (!/^[a-z0-9-]+$/.test(slug)) {
    return { error: "The slug can contain lowercase letters, numbers and hyphens only." };
  }
  if (!CURRENCIES.includes(baseCurrency)) {
    return { error: "Choose a reporting currency." };
  }

  try {
    await auth.api.updateOrganization({
      body: { organizationId, data: { name, slug, baseCurrency } },
      headers: request.headers,
    });
    return { ok: true as const };
  } catch (error) {
    return { error: readableAuthError(error, "Could not save the organization.") };
  }
}

export default function OrganizationSettings({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const navigation = useNavigation();
  const { organization, viewerRole, canEdit, canDelete } = loaderData;
  const submittingIntent = navigation.formData?.get("intent")?.toString() ?? null;

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-gray-200 bg-white p-6">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-gray-100">
              <Building2 className="h-5 w-5 text-gray-600" />
            </span>
            <div>
              <h1 className="text-lg font-semibold text-gray-900">
                {organization.name}
              </h1>
              <p className="text-sm text-gray-600">
                {organization.memberCount}{" "}
                {organization.memberCount === 1 ? "member" : "members"}
              </p>
            </div>
          </div>
          <RoleBadge role={viewerRole} />
        </div>

        <Form method="post" className="mt-6 max-w-md space-y-5">
          <input type="hidden" name="intent" value="update" />

          {actionData?.error && submittingIntent !== "delete" ? (
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

          <div>
            <label htmlFor="name" className="mb-2 block text-sm font-semibold text-gray-700">
              Organization name
            </label>
            <input
              id="name"
              name="name"
              type="text"
              required
              disabled={!canEdit}
              defaultValue={organization.name}
              className="block h-12 w-full rounded-xl border border-gray-200 bg-gray-50 px-4 transition focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/20 disabled:bg-gray-100 disabled:text-gray-500"
            />
          </div>

          <div>
            <label htmlFor="slug" className="mb-2 block text-sm font-semibold text-gray-700">
              Slug
            </label>
            <input
              id="slug"
              name="slug"
              type="text"
              required
              pattern="[a-z0-9-]+"
              disabled={!canEdit}
              defaultValue={organization.slug}
              className="block h-12 w-full rounded-xl border border-gray-200 bg-gray-50 px-4 transition focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/20 disabled:bg-gray-100 disabled:text-gray-500"
            />
          </div>

          <div>
            <label
              htmlFor="baseCurrency"
              className="mb-2 block text-sm font-semibold text-gray-700"
            >
              Reporting currency
            </label>
            <select
              id="baseCurrency"
              name="baseCurrency"
              required
              disabled={!canEdit}
              defaultValue={organization.baseCurrency}
              className="block h-12 w-full rounded-xl border border-gray-200 bg-gray-50 px-4 transition focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/20 disabled:bg-gray-100 disabled:text-gray-500"
            >
              {CURRENCIES.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
            <p className="mt-2 text-xs text-gray-500">
              Changing this changes what every cross-store total is converted
              into. Historical rates are used, and the rate is always shown.
            </p>
          </div>

          {canEdit ? (
            <button
              type="submit"
              disabled={navigation.state === "submitting"}
              className="flex h-11 items-center justify-center gap-2 rounded-xl bg-primary-500 px-6 font-semibold text-white transition hover:bg-primary-600 disabled:opacity-50"
            >
              {submittingIntent === "update" ? <LoadingSpinner size="sm" /> : null}
              <span>Save changes</span>
            </button>
          ) : (
            <p className="text-sm text-gray-500">
              Your role can view these settings but not change them.
            </p>
          )}
        </Form>
      </section>

      {canDelete ? (
        <section className="rounded-2xl border border-red-200 bg-white p-6">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-red-50">
              <Trash2 className="h-5 w-5 text-red-600" />
            </span>
            <div>
              <h2 className="text-lg font-semibold text-gray-900">Danger zone</h2>
              <p className="text-sm text-gray-600">
                Deleting the organization removes its members and invitations.
              </p>
            </div>
          </div>

          <Form method="post" className="mt-6 max-w-md space-y-4">
            <input type="hidden" name="intent" value="delete" />
            <input type="hidden" name="slug" value={organization.slug} />

            {actionData?.error && submittingIntent === "delete" ? (
              <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0" />
                <span>{actionData.error}</span>
              </div>
            ) : null}

            <div>
              <label
                htmlFor="confirmSlug"
                className="mb-2 block text-sm font-medium text-gray-700"
              >
                Type <code className="font-semibold">{organization.slug}</code> to
                confirm
              </label>
              <input
                id="confirmSlug"
                name="confirmSlug"
                type="text"
                autoComplete="off"
                className="block h-12 w-full rounded-xl border border-gray-200 bg-gray-50 px-4 transition focus:border-red-500 focus:outline-none focus:ring-2 focus:ring-red-500/20"
              />
            </div>

            <button
              type="submit"
              disabled={navigation.state === "submitting"}
              className="flex h-11 items-center justify-center gap-2 rounded-xl bg-red-600 px-6 font-semibold text-white transition hover:bg-red-700 disabled:opacity-50"
            >
              {submittingIntent === "delete" ? (
                <LoadingSpinner size="sm" />
              ) : (
                <Trash2 className="h-4 w-4" />
              )}
              <span>Delete organization</span>
            </button>
          </Form>
        </section>
      ) : null}
    </div>
  );
}
