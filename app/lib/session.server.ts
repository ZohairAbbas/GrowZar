import { redirect } from "react-router";

import { auth } from "./auth.server";
import { appPathWithSearch } from "./redirects";

/**
 * Session helpers for loaders and actions.
 *
 * Every screen in Growzar is per-merchant data, so the question a loader asks
 * is always one of these three, and never "is there a cookie".
 */

export async function getSession(request: Request) {
  return auth.api.getSession({ headers: request.headers });
}

/** Signed in, or bounced to sign-in with somewhere to come back to. */
export async function requireUser(request: Request) {
  const session = await getSession(request);
  if (!session) {
    // The page, not the `.data` endpoint of a client-side navigation.
    const next = appPathWithSearch(request);
    throw redirect(
      `/auth/sign-in?next=${encodeURIComponent(next)}`,
    );
  }
  return session;
}

/**
 * Signed in AND inside an organization. A user with no organization yet is
 * sent to create one; this is the state a plain email sign-up lands in, before
 * any store is claimed.
 */
export async function requireOrganization(request: Request): Promise<{
  session: Awaited<ReturnType<typeof requireUser>>;
  organizationId: string;
}> {
  const session = await requireUser(request);

  if (session.session.activeOrganizationId) {
    return {
      session,
      organizationId: session.session.activeOrganizationId,
    };
  }

  // No active organization on the session. If the user belongs to exactly one,
  // make it active rather than asking them a question with one answer.
  const organizations = await auth.api.listOrganizations({
    headers: request.headers,
  });

  if (organizations.length === 0) {
    throw redirect("/organizations/new");
  }

  const [first] = organizations;
  const response = await auth.api.setActiveOrganization({
    body: { organizationId: first!.id },
    headers: request.headers,
    asResponse: true,
  });

  // Sessions are cookie-cached, so the active organization only becomes true
  // for the *next* request once the refreshed cookie reaches the browser.
  // Returning here would render this page against a stale cookie and every
  // organization-scoped call in the loader would still see no active
  // organization. Bouncing through the same URL carries the cookie out.
  throw redirectWithCookies(response, appPathWithSearch(request));
}

/**
 * The viewer's membership row, read from the organization rather than from the
 * session. `getActiveMember` answers the same question but reads the session's
 * active organization, which is cookie-cached and therefore one request behind
 * any change made server-side.
 */
export function findViewerMember<T extends { userId: string }>(
  members: T[],
  userId: string,
): T | undefined {
  return members.find((member) => member.userId === userId);
}

/**
 * Better Auth's server API can hand back a full `Response` so its Set-Cookie
 * headers are exact. A loader or action still needs to redirect, so this
 * carries those cookies onto a redirect of our choosing.
 *
 * Every cookie is copied, not just the first: sign-in sets the session cookie
 * and, with cookie caching on, a signed data cookie beside it.
 */
export function redirectWithCookies(response: Response, to: string) {
  // `asResponse: true` makes Better Auth RETURN failures rather than throw
  // them, so a 401 arrives here looking exactly like a success. Redirecting on
  // one sends the person to a page as if they had signed in, with no session
  // and no explanation. Callers that can show the user a message check
  // `readAuthFailure` first; this is the backstop, and it is loud on purpose.
  if (!response.ok) {
    throw new Error(
      `redirectWithCookies got a ${response.status} — call readAuthFailure first`,
    );
  }

  const headers = new Headers();
  for (const cookie of response.headers.getSetCookie()) {
    headers.append("Set-Cookie", cookie);
  }
  return redirect(to, { headers });
}

/**
 * The human-readable reason a Better Auth call failed, or null if it did not.
 *
 * Consumes the body, so it is called once per response and before
 * `redirectWithCookies`.
 */
export async function readAuthFailure(
  response: Response,
  fallback: string,
): Promise<string | null> {
  if (response.ok) return null;

  try {
    const body = (await response.clone().json()) as { message?: unknown };
    if (typeof body.message === "string" && body.message) return body.message;
  } catch {
    /* not JSON */
  }

  console.error(`[auth] request failed with ${response.status}`);
  return fallback;
}

/**
 * Better Auth throws `APIError` with a `body.message` a person can read.
 * Anything else is ours to log and describe generically, because an internal
 * message is not a thing to put in front of a merchant.
 */
export function readableAuthError(error: unknown, fallback: string): string {
  if (
    error &&
    typeof error === "object" &&
    "body" in error &&
    error.body &&
    typeof error.body === "object" &&
    "message" in error.body &&
    typeof error.body.message === "string"
  ) {
    return error.body.message;
  }
  console.error("[auth] unexpected failure", error);
  return fallback;
}
