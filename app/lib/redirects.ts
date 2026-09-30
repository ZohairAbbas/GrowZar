/**
 * `next` always arrives from a URL or a form field, so it is attacker
 * controlled: a crafted sign-in link that bounces the merchant to a lookalike
 * host after a genuine sign-in is the whole point of an open redirect.
 *
 * Only a path on this host is ever followed. `//evil.com` and
 * `https:/evil.com` both start with a slash and are both absolute, which is
 * why the second character and the backslash are checked too — browsers
 * normalize `\` to `/` in URLs.
 */
export function safeRedirectPath(
  value: FormDataEntryValue | string | null | undefined,
  fallback = "/",
): string {
  if (typeof value !== "string") return fallback;

  const trimmed = value.trim();
  if (!trimmed.startsWith("/")) return fallback;
  if (trimmed.startsWith("//") || trimmed.startsWith("/\\")) return fallback;
  if (trimmed.includes("\\")) return fallback;

  return trimmed;
}

/**
 * The page URL a request is *for*, with React Router's single-fetch details
 * removed.
 *
 * A client-side navigation does not request `/finance`: it requests
 * `/finance.data?_routes=…` (`/_.data` for a trailing slash). React Router
 * hands loaders a normalised `url` beside the raw `request`, and a loader
 * should read that. This is for helpers that receive only the request — a
 * "come back here after sign-in" built from the raw URL sends the browser to
 * the `.data` endpoint instead of the page. Mirrors React Router 8's
 * `getNormalizedPath` (server-runtime/urls.js).
 */
export function appUrl(request: Request | string): URL {
  const url = new URL(typeof request === "string" ? request : request.url);
  if (url.pathname.endsWith("/_.data")) url.pathname = url.pathname.slice(0, -"_.data".length);
  else if (url.pathname.endsWith(".data")) url.pathname = url.pathname.slice(0, -".data".length);
  url.searchParams.delete("_routes");
  return url;
}

/** `pathname + search` of `appUrl`, for a redirect back to the same page. */
export function appPathWithSearch(request: Request | string): string {
  const url = appUrl(request);
  return `${url.pathname}${url.search}`;
}

