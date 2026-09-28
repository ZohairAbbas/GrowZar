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
