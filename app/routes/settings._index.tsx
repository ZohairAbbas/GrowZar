import { Form, useNavigation } from "react-router";
import { AlertCircle, Check, User } from "lucide-react";

import type { Route } from "./+types/settings._index";
import { auth } from "~/lib/auth.server";
import { readableAuthError, requireUser } from "~/lib/session.server";
import { LoadingSpinner } from "~/components/ui/LoadingSpinner";

export function meta() {
  return [{ title: "Personal settings · Growzar" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const session = await requireUser(request);
  return {
    user: {
      name: session.user.name,
      email: session.user.email,
    },
  };
}

export async function action({ request }: Route.ActionArgs) {
  await requireUser(request);

  const formData = await request.formData();
  const name = String(formData.get("name") ?? "").trim();

  if (!name) {
    return { error: "Your name cannot be empty." };
  }

  try {
    await auth.api.updateUser({ body: { name }, headers: request.headers });
    return { ok: true as const };
  } catch (error) {
    return { error: readableAuthError(error, "Could not save your details.") };
  }
}

export default function PersonalSettings({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const navigation = useNavigation();

  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-6">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-gray-100">
          <User className="h-5 w-5 text-gray-600" />
        </span>
        <div>
          <h1 className="text-lg font-semibold text-gray-900">Your account</h1>
          <p className="text-sm text-gray-600">
            How you appear to the rest of your team.
          </p>
        </div>
      </div>

      <Form method="post" className="mt-6 max-w-md space-y-5">
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

        <div>
          <label htmlFor="name" className="mb-2 block text-sm font-semibold text-gray-700">
            Name
          </label>
          <input
            id="name"
            name="name"
            type="text"
            required
            defaultValue={loaderData.user.name}
            className="block h-12 w-full rounded-xl border border-gray-200 bg-gray-50 px-4 transition focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/20"
          />
        </div>

        <div>
          <label className="mb-2 block text-sm font-semibold text-gray-700">
            Email
          </label>
          <input
            type="email"
            value={loaderData.user.email}
            disabled
            className="block h-12 w-full rounded-xl border border-gray-200 bg-gray-100 px-4 text-gray-500"
          />
          <p className="mt-2 text-xs text-gray-500">
            Changing your sign-in address is not part of Phase 1.
          </p>
        </div>

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
  );
}
