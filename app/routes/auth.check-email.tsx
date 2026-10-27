import { Form, Link, useNavigation, useSearchParams } from "react-router";
import { AlertCircle, LogIn, Mail } from "lucide-react";

import type { Route } from "./+types/auth.check-email";
import { auth } from "~/lib/auth.server";
import { readFormData } from "~/lib/form.server";
import { safeRedirectPath } from "~/lib/redirects";
import { readAuthFailure, readableAuthError, redirectWithCookies } from "~/lib/session.server";
import { codeFailure, readCode } from "~/lib/sign-in-code";
import { LoadingSpinner } from "~/components/ui/LoadingSpinner";

export function meta() {
  return [{ title: "Check your email · Growzar" }];
}

/**
 * The 6-digit code from the same email, typed here (pre-Wave-1 pack 3). This
 * is how the installed app on an iPhone signs in: the email's link opens in
 * Safari, which keeps its cookies apart from the home-screen app.
 */
export async function action({ request }: Route.ActionArgs) {
  const form = await readFormData(request);
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const next = safeRedirectPath(String(form.get("next") ?? ""));
  const otp = readCode(String(form.get("code") ?? ""));
  if (!email) return { error: "This page lost your email address. Go back to sign in and ask again." };
  if (!otp) return { error: "Type the 6 digits from the email." };

  try {
    const response = await auth.api.signInEmailOTP({ body: { email, otp }, headers: request.headers, asResponse: true });
    if (!response.ok) {
      const message = await readAuthFailure(response, "");
      return { error: codeFailure(message || null) };
    }
    return redirectWithCookies(response, next);
  } catch (error) {
    return { error: readableAuthError(error, "That code could not be checked. Try again.") };
  }
}

/**
 * Shown after a magic link is requested. It says the same thing whether or not
 * the address belongs to an account, because anything else turns this page
 * into an address checker.
 */
export default function CheckEmail({ actionData }: Route.ComponentProps) {
  const [searchParams] = useSearchParams();
  const navigation = useNavigation();
  const email = searchParams.get("email");
  const next = searchParams.get("next") ?? "";

  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-12">
      <div className="w-full max-w-md rounded-2xl bg-white p-8 text-center shadow-xl">
        <span className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-accent-50">
          <Mail className="h-8 w-8 text-accent-500" />
        </span>
        <h1 className="font-display text-2xl font-bold text-gray-900">Check your email</h1>
        <p className="mt-2 text-sm leading-relaxed text-gray-600">
          If {email ? <strong>{email}</strong> : "that address"} has a Growzar
          account, a sign-in link and a 6-digit code are on their way. Both
          expire in 10 minutes.
        </p>

        {email ? (
          <Form method="post" className="mt-6 space-y-3 text-left">
            <input type="hidden" name="email" value={email} />
            <input type="hidden" name="next" value={next} />
            <label htmlFor="code" className="block text-sm font-semibold text-gray-700">
              Or type the code here
            </label>
            {actionData?.error ? (
              <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0" />
                <span>{actionData.error}</span>
              </div>
            ) : null}
            <div className="flex gap-2">
              <input
                id="code"
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={9}
                required
                placeholder="123 456"
                className="block h-12 min-w-0 flex-1 rounded-xl border border-gray-200 bg-gray-50 px-4 text-lg tracking-widest transition focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/20"
              />
              <button
                type="submit"
                disabled={navigation.state === "submitting"}
                className="flex h-12 flex-shrink-0 items-center justify-center gap-2 rounded-full bg-primary-500 px-5 font-semibold text-white transition hover:bg-primary-600 disabled:opacity-50"
              >
                {navigation.state === "submitting" ? <LoadingSpinner size="sm" /> : <LogIn className="h-4 w-4" />}
                <span>Sign in</span>
              </button>
            </div>
          </Form>
        ) : null}

        <Link
          to="/auth/sign-in"
          className="mt-6 inline-flex min-h-11 items-center text-sm font-semibold text-accent-500 hover:text-accent-600"
        >
          Back to sign in
        </Link>
      </div>
    </main>
  );
}
