import { Form, redirect, useNavigation } from "react-router";
import { AlertCircle, Building2 } from "lucide-react";

import type { Route } from "./+types/organizations.new";
import { auth } from "~/lib/auth.server";
import {
  readableAuthError,
  redirectWithCookies,
  requireUser,
} from "~/lib/session.server";
import { LoadingSpinner } from "~/components/ui/LoadingSpinner";

export function meta() {
  return [{ title: "Create an organization · Growzar" }];
}

/**
 * Ported from salvage/components/settings/CreateOrganizationForm.tsx.
 *
 * Rewired rather than copied: the salvaged version was a client component that
 * POSTed to /api/organizations, then POSTed again to switch, then called
 * Mixpanel three times. Here the whole thing is one action — Better Auth's
 * createOrganization already makes the creator the owner and sets the
 * organization active. The slug generator and the layout are the parts that
 * carried over.
 *
 * What is new: base currency. The old hub had no such concept; Growzar
 * converts every store's money into it, so it is asked for once, here, with no
 * preselected option (rule #4 — never default a currency).
 */
const CURRENCIES = [
  { code: "PKR", label: "PKR — Pakistani rupee" },
  { code: "USD", label: "USD — US dollar" },
  { code: "AED", label: "AED — UAE dirham" },
  { code: "SAR", label: "SAR — Saudi riyal" },
  { code: "GBP", label: "GBP — Pound sterling" },
  { code: "EUR", label: "EUR — Euro" },
];

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  return null;
}

export async function action({ request }: Route.ActionArgs) {
  await requireUser(request);

  const formData = await request.formData();
  const name = String(formData.get("name") ?? "").trim();
  const slug = String(formData.get("slug") ?? "").trim().toLowerCase();
  const baseCurrency = String(formData.get("baseCurrency") ?? "").toUpperCase();

  if (!name || !slug) {
    return { error: "A name and a slug are both required." };
  }
  if (!/^[a-z0-9-]+$/.test(slug)) {
    return { error: "The slug can contain lowercase letters, numbers and hyphens only." };
  }
  if (!CURRENCIES.some((c) => c.code === baseCurrency)) {
    return { error: "Choose the currency your organization reports in." };
  }

  try {
    const organization = await auth.api.createOrganization({
      body: { name, slug, baseCurrency },
      headers: request.headers,
    });

    // The cookie this returns is what makes the new organization active on the
    // next request; sessions are cookie-cached, so dropping it would leave the
    // user organization-less until the cache expired.
    const activated = await auth.api.setActiveOrganization({
      body: { organizationId: organization!.id },
      headers: request.headers,
      asResponse: true,
    });

    throw redirectWithCookies(activated, "/settings/organization");
  } catch (error) {
    // A redirect is thrown, not returned, so let it through untouched.
    if (error instanceof Response) throw error;
    return { error: readableAuthError(error, "Could not create the organization.") };
  }
}

export default function NewOrganization({ actionData }: Route.ComponentProps) {
  const navigation = useNavigation();

  // Suggest a slug from the name as it is typed, without taking the field
  // over: once the slug input is touched it keeps whatever it holds.
  const onNameInput = (event: React.FormEvent<HTMLInputElement>) => {
    const form = event.currentTarget.form;
    const slugInput = form?.elements.namedItem("slug") as HTMLInputElement | null;
    if (!slugInput || slugInput.dataset.touched === "true") return;
    slugInput.value = event.currentTarget.value
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .slice(0, 50);
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-12">
      <div className="w-full max-w-lg rounded-2xl bg-white p-8 shadow-xl">
        <span className="mb-5 flex h-12 w-12 items-center justify-center rounded-xl bg-primary-500">
          <Building2 className="h-6 w-6 text-white" />
        </span>
        <h1 className="text-xl font-semibold text-gray-900">
          Create your organization
        </h1>
        <p className="mt-1.5 text-sm text-gray-600">
          Your company. Stores, staff and permissions all live inside it.
        </p>

        <Form method="post" className="mt-7 space-y-6">
          {actionData?.error ? (
            <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0" />
              <span>{actionData.error}</span>
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
              onInput={onNameInput}
              placeholder="Acme Traders"
              className="block h-12 w-full rounded-xl border border-gray-200 bg-gray-50 px-4 transition focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/20"
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
              onChange={(event) => {
                event.currentTarget.dataset.touched = "true";
                event.currentTarget.value = event.currentTarget.value.toLowerCase();
              }}
              placeholder="acme-traders"
              className="block h-12 w-full rounded-xl border border-gray-200 bg-gray-50 px-4 transition focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/20"
            />
            <p className="mt-2 text-xs text-gray-500">
              Lowercase letters, numbers and hyphens. Used in URLs.
            </p>
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
              defaultValue=""
              className="block h-12 w-full rounded-xl border border-gray-200 bg-gray-50 px-4 transition focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/20"
            >
              <option value="" disabled>
                Choose a currency
              </option>
              {CURRENCIES.map((currency) => (
                <option key={currency.code} value={currency.code}>
                  {currency.label}
                </option>
              ))}
            </select>
            <p className="mt-2 text-xs text-gray-500">
              Totals across stores are converted into this currency, at the
              historical daily rate, with the rate always shown.
            </p>
          </div>

          <button
            type="submit"
            disabled={navigation.state === "submitting"}
            className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-primary-500 font-semibold text-white transition hover:bg-primary-600 disabled:opacity-50"
          >
            {navigation.state === "submitting" ? (
              <LoadingSpinner size="sm" />
            ) : (
              <Building2 className="h-4 w-4" />
            )}
            <span>Create organization</span>
          </button>
        </Form>
      </div>
    </main>
  );
}
