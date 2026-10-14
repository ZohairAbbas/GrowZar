import { Form, Link, redirect, useNavigation } from "react-router";
import { AlertCircle, LogIn } from "lucide-react";

import type { Route } from "./+types/auth.magic-link";
import { auth } from "~/lib/auth.server";
import { env } from "~/lib/env.server";
import { readFormData } from "~/lib/form.server";
import { LoadingSpinner } from "~/components/ui/LoadingSpinner";

export function meta() {
  return [{ title: "Sign in · Growzar" }];
}

/**
 * Where a sign-in email's link lands (fix for the Microsoft 365 Safe Links
 * lockout, 2026-09-29). Opening this page uses nothing up: a link scanner
 * that fetches it, as Safe Links does with every emailed link, leaves the
 * token for the person. Only the button below verifies it, through Better
 * Auth's own endpoint, so expiry, single use and rate limiting stay its.
 */
const FIELDS = ["token", "callbackURL", "newUserCallbackURL", "errorCallbackURL"] as const;

export function loader({ url }: Route.LoaderArgs) {
  const token = url.searchParams.get("token");
  return { fields: token ? Object.fromEntries(FIELDS.flatMap((f) => (url.searchParams.get(f) ? [[f, url.searchParams.get(f)!]] : []))) : null };
}

/** Headers worth passing on to the verify call: who is asking, not the form post itself. */
const PASSED = ["cookie", "user-agent", "x-forwarded-for", "x-real-ip", "accept-language"];

export async function action({ request }: Route.ActionArgs) {
  const form = await readFormData(request);
  const token = form.get("token");
  if (typeof token !== "string" || !token) return { error: "This sign-in link is incomplete. Ask for a new one." };

  const verify = new URL("/api/auth/magic-link/verify", env.BETTER_AUTH_URL);
  for (const f of FIELDS) {
    const v = form.get(f);
    if (typeof v === "string" && v) verify.searchParams.set(f, v);
  }
  const headers = new Headers();
  for (const h of PASSED) {
    const v = request.headers.get(h);
    if (v) headers.set(h, v);
  }
  const response = await auth.handler(new Request(verify, { method: "GET", headers }));

  const location = response.headers.get("location");
  if (!location) {
    console.error(`[auth] magic-link verify answered ${response.status} with no redirect`);
    return { error: "That link could not be used. Ask for a new one." };
  }
  // Better Auth reports a used-up or expired token by redirecting with ?error=.
  const target = new URL(location, env.BETTER_AUTH_URL);
  if (target.searchParams.get("error")) return { error: "This sign-in link has expired or was already used. Ask for a new one." };

  const out = new Headers();
  for (const cookie of response.headers.getSetCookie()) out.append("Set-Cookie", cookie);
  const sameSite = target.origin === new URL(env.BETTER_AUTH_URL).origin;
  throw redirect(sameSite ? `${target.pathname}${target.search}` : "/", { headers: out });
}

export default function MagicLink({ loaderData, actionData }: Route.ComponentProps) {
  const navigation = useNavigation();
  const error = actionData?.error ?? (loaderData.fields ? null : "This sign-in link is incomplete. Ask for a new one.");
  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-12">
      <div className="w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-xl">
        <div className="bg-primary-500 px-8 py-7 text-white">
          <span className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-white/10 font-display text-xl font-bold leading-none text-mint">
            g
          </span>
          <h1 className="font-display text-2xl font-bold">Sign in to Growzar</h1>
        </div>
        <div className="space-y-6 p-8">
          {error ? (
            <>
              <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0" />
                <span>{error}</span>
              </div>
              <Link to="/auth/sign-in" className="block text-center text-sm font-semibold text-accent-500 hover:text-accent-600">
                Back to sign in
              </Link>
            </>
          ) : (
            <Form method="post" className="space-y-4">
              {Object.entries(loaderData.fields ?? {}).map(([name, value]) => (
                <input key={name} type="hidden" name={name} value={value} />
              ))}
              <p className="text-sm text-gray-600">Press the button to finish signing in. The link works once and expires 10 minutes after it was sent.</p>
              <button
                type="submit"
                disabled={navigation.state === "submitting"}
                className="flex h-12 w-full items-center justify-center gap-2 rounded-full bg-primary-500 font-semibold text-white transition hover:bg-primary-600 disabled:opacity-50"
              >
                {navigation.state === "submitting" ? <LoadingSpinner size="sm" /> : <LogIn className="h-4 w-4" />}
                <span>Sign in</span>
              </button>
            </Form>
          )}
        </div>
      </div>
    </main>
  );
}
