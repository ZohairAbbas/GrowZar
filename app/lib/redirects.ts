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
