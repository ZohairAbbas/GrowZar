/**
 * The store the shell is pointed at, remembered in a cookie.
 *
 * Its own module rather than an export from a route: a route module that
 * imports a helper from *another* route module drags that route's whole
 * server-side import graph with it, which the production build refuses.
 */
export const STORE_COOKIE = "growzar_store";

export const STORE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function readStoreCookie(request: Request): string | null {
  const cookie = request.headers.get("Cookie") ?? "";
  const match = cookie.match(new RegExp(`(?:^|; )${STORE_COOKIE}=([^;]+)`));
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

/**
 * A link that names its store (`?store=`, as "talk to your data" builds
 * them): remember that store, if the viewer may see it, and reload the same
 * screen without the parameter, so every link on it keeps working as usual.
 * Returns nothing when the URL names no store, or one outside `visible`.
 */
export function rememberLinkedStore(url: URL, visible: ReadonlyArray<{ id: string }>): Response | null {
  const asked = url.searchParams.get("store");
  if (!asked) return null;
  const rest = new URLSearchParams(url.searchParams);
  rest.delete("store");
  const to = `${url.pathname}${rest.size ? `?${rest}` : ""}`;
  if (!visible.some((s) => s.id === asked)) return new Response(null, { status: 302, headers: { Location: to } });
  return new Response(null, {
    status: 302,
    headers: {
      Location: to,
      "Set-Cookie": `${STORE_COOKIE}=${encodeURIComponent(asked)}; Path=/; Max-Age=${STORE_COOKIE_MAX_AGE}; SameSite=Lax; HttpOnly`,
    },
  });
}
