import { Form, Link, redirect, useNavigation, useSearchParams } from "react-router";
import { AlertCircle, UserPlus } from "lucide-react";

import type { Route } from "./+types/auth.sign-up";
import { auth } from "~/lib/auth.server";
import { readFormData } from "~/lib/form.server";
import { safeRedirectPath } from "~/lib/redirects";
import {
  getSession,
  readAuthFailure,
  readableAuthError,
  redirectWithCookies,
} from "~/lib/session.server";
import { LoadingSpinner } from "~/components/ui/LoadingSpinner";

export function meta() {
  return [{ title: "Create an account · Growzar" }];
}

const MIN_PASSWORD_LENGTH = 10;

export async function loader({ request }: Route.LoaderArgs) {
  const session = await getSession(request);
  if (session) {
    throw redirect(safeRedirectPath(new URL(request.url).searchParams.get("next")));
  }
  return null;
}

export async function action({ request }: Route.ActionArgs) {
  const formData = await readFormData(request);
  const name = String(formData.get("name") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const next = safeRedirectPath(String(formData.get("next") ?? ""));

  if (!name || !email || !password) {
    return { error: "Name, email and password are all required." };
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return {
      error: `Use at least ${MIN_PASSWORD_LENGTH} characters for your password.`,
    };
  }

  try {
    const response = await auth.api.signUpEmail({
      body: { name, email, password },
      headers: request.headers,
      asResponse: true,
    });

    const failure = await readAuthFailure(
      response,
      "Could not create that account.",
    );
    if (failure) return { error: failure };
    // A fresh account has no organization. `next` is honoured when it points
    // somewhere specific — an invitation, say — and otherwise the user goes to
    // create one, which is what requireOrganization would do anyway.
    return redirectWithCookies(response, next === "/" ? "/organizations/new" : next);
  } catch (error) {
    return {
      error: readableAuthError(error, "Could not create that account."),
    };
  }
}

export default function SignUp({ actionData }: Route.ComponentProps) {
  const [searchParams] = useSearchParams();
  const navigation = useNavigation();
  const next = searchParams.get("next") ?? "";

  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-12">
      <div className="w-full max-w-md">
        <div className="overflow-hidden rounded-2xl bg-white shadow-xl">
          <div className="bg-primary-500 px-8 py-7 text-white">
            <h1 className="text-xl font-semibold">Create your Growzar account</h1>
            <p className="mt-1 text-sm text-gray-300">
              Then connect the stores you already run.
            </p>
          </div>

          <div className="space-y-6 p-8">
            {actionData?.error ? (
              <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0" />
                <span>{actionData.error}</span>
              </div>
            ) : null}

            <Form method="post" className="space-y-4">
              <input type="hidden" name="next" value={next} />

              <div>
                <label
                  htmlFor="name"
                  className="mb-2 block text-sm font-semibold text-gray-700"
                >
                  Your name
                </label>
                <input
                  id="name"
                  name="name"
                  type="text"
                  autoComplete="name"
                  required
                  className="block h-12 w-full rounded-xl border border-gray-200 bg-gray-50 px-4 transition focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/20"
                />
              </div>

              <div>
                <label
                  htmlFor="email"
                  className="mb-2 block text-sm font-semibold text-gray-700"
                >
                  Email
                </label>
                <input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                  className="block h-12 w-full rounded-xl border border-gray-200 bg-gray-50 px-4 transition focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/20"
                />
              </div>

              <div>
                <label
                  htmlFor="password"
                  className="mb-2 block text-sm font-semibold text-gray-700"
                >
                  Password
                </label>
                <input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={MIN_PASSWORD_LENGTH}
                  className="block h-12 w-full rounded-xl border border-gray-200 bg-gray-50 px-4 transition focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/20"
                />
                <p className="mt-2 text-xs text-gray-500">
                  At least {MIN_PASSWORD_LENGTH} characters.
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
                  <UserPlus className="h-4 w-4" />
                )}
                <span>Create account</span>
              </button>
            </Form>

            <p className="text-center text-sm text-gray-500">
              Already have an account?{" "}
              <Link
                to={next ? `/auth/sign-in?next=${encodeURIComponent(next)}` : "/auth/sign-in"}
                className="font-semibold text-accent-500 hover:text-accent-600"
              >
                Sign in
              </Link>
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}
