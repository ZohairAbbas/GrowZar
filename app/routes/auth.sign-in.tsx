import { Form, Link, redirect, useNavigation, useSearchParams } from "react-router";
import { AlertCircle, KeyRound, Mail } from "lucide-react";

import type { Route } from "./+types/auth.sign-in";
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
  return [{ title: "Sign in · Growzar" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const session = await getSession(request);
  if (session) {
    throw redirect(safeRedirectPath(new URL(request.url).searchParams.get("next")));
  }
  return null;
}

export async function action({ request }: Route.ActionArgs) {
  const formData = await readFormData(request);
  const intent = String(formData.get("intent") ?? "password");
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const next = safeRedirectPath(String(formData.get("next") ?? ""));

  if (!email) {
    return { error: "Enter your email address.", intent };
  }

  if (intent === "magic-link") {
    try {
      await auth.api.signInMagicLink({
        body: { email, callbackURL: next },
        headers: request.headers,
      });
    } catch (error) {
      // A failure here is almost always the mailer. Do not leak whether the
      // address exists; the next screen says the same thing either way.
      readableAuthError(error, "Could not send the link.");
    }
    throw redirect(`/auth/check-email?email=${encodeURIComponent(email)}`);
  }

  const password = String(formData.get("password") ?? "");
  if (!password) {
    return { error: "Enter your password.", intent };
  }

  try {
    const response = await auth.api.signInEmail({
      body: { email, password },
      headers: request.headers,
      asResponse: true,
    });

    const failure = await readAuthFailure(
      response,
      "That email and password did not match.",
    );
    if (failure) return { error: failure, intent };

    return redirectWithCookies(response, next);
  } catch (error) {
    return {
      error: readableAuthError(error, "That email and password did not match."),
      intent,
    };
  }
}

export default function SignIn({ actionData }: Route.ComponentProps) {
  const [searchParams] = useSearchParams();
  const navigation = useNavigation();
  const next = searchParams.get("next") ?? "";
  const submittingIntent =
    navigation.formData?.get("intent")?.toString() ?? null;

  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-12">
      <div className="w-full max-w-md">
        <div className="overflow-hidden rounded-2xl bg-white shadow-xl">
          <div className="bg-primary-500 px-8 py-7 text-white">
            <h1 className="text-xl font-semibold">Sign in to Growzar</h1>
            <p className="mt-1 text-sm text-gray-300">
              One place for the apps you already run.
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
                  placeholder="you@company.pk"
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
                  autoComplete="current-password"
                  className="block h-12 w-full rounded-xl border border-gray-200 bg-gray-50 px-4 transition focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/20"
                />
              </div>

              <button
                type="submit"
                name="intent"
                value="password"
                disabled={navigation.state === "submitting"}
                className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-primary-500 font-semibold text-white transition hover:bg-primary-600 disabled:opacity-50"
              >
                {submittingIntent === "password" ? (
                  <LoadingSpinner size="sm" />
                ) : (
                  <KeyRound className="h-4 w-4" />
                )}
                <span>Sign in</span>
              </button>

              <div className="flex items-center gap-3 py-1">
                <span className="h-px flex-1 bg-gray-200" />
                <span className="text-xs font-medium uppercase tracking-wide text-gray-400">
                  or
                </span>
                <span className="h-px flex-1 bg-gray-200" />
              </div>

              <button
                type="submit"
                name="intent"
                value="magic-link"
                disabled={navigation.state === "submitting"}
                className="flex h-12 w-full items-center justify-center gap-2 rounded-xl border-2 border-gray-300 font-semibold text-gray-700 transition hover:bg-gray-50 disabled:opacity-50"
              >
                {submittingIntent === "magic-link" ? (
                  <LoadingSpinner size="sm" />
                ) : (
                  <Mail className="h-4 w-4" />
                )}
                <span>Email me a sign-in link</span>
              </button>
            </Form>

            <p className="text-center text-sm text-gray-500">
              New here?{" "}
              <Link
                to={next ? `/auth/sign-up?next=${encodeURIComponent(next)}` : "/auth/sign-up"}
                className="font-semibold text-accent-500 hover:text-accent-600"
              >
                Create an account
              </Link>
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}
