/**
 * Who may use Books, as pure rules (B2). The Books engine (app/lib/books)
 * knows nothing of Growzar's members and roles; this is the glue.
 *
 * - Section × action comes from the role (D-80): owner and admin manage,
 *   manager views and exports, staff has none, the accountant manages.
 * - One book covers the whole organization, so only members scoped to all
 *   stores may open it (D-81).
 * - Closing and reopening a period is for owners and admins only (D-70);
 *   an accountant prepares a close for them to confirm.
 */

/** The server's kill switch, read like Ask's and Plan's. */
export const booksServerOn = (value: string | undefined) => ["on", "true", "1"].includes((value ?? "").trim().toLowerCase());

/** `null` scope means every store (scope.ts). */
export function scopeAllowsBooks(scopedStoreIds: string[] | null): boolean {
  return scopedStoreIds === null;
}

/** A member may hold several roles ("admin,accountant"); any owner or admin role closes. */
export function canClosePeriod(role: string): boolean {
  return role
    .split(",")
    .map((r) => r.trim())
    .some((r) => r === "owner" || r === "admin");
}
