/**
 * Store scope, as pure rules (D-20).
 *
 * Kept away from the database and from Better Auth so the decisions can be
 * stated and tested on their own. `authorize.server.ts` is the only caller.
 */

/**
 * `null` means every store in the organization. An array means exactly those
 * stores, and an empty array means none at all.
 *
 * Only an explicit `false` narrows anything. The generated `scopeAllStores`
 * column is nullable, so a member row written before scoping existed — or by
 * any Better Auth path that does not know about the column — reads as `null`,
 * and that must keep meaning "all stores". Treating null as "no stores" would
 * lock existing members out of their own data the moment this shipped.
 */
export function resolveScopedStoreIds(
  scopeAllStores: boolean | null | undefined,
  scopeRows: { storeId: string }[],
): string[] | null {
  if (scopeAllStores !== false) return null;
  return scopeRows.map((row) => row.storeId);
}

/** Is this store inside the scope? */
export function isStoreInScope(
  scopedStoreIds: string[] | null,
  storeId: string,
): boolean {
  return scopedStoreIds === null || scopedStoreIds.includes(storeId);
}

/**
 * The `where` fragment that narrows a store query. Spread into a Prisma
 * filter that already constrains the organization — this narrows, it never
 * grants, so it is never the only condition on a query.
 */
export function storeScopeFilter(scopedStoreIds: string[] | null) {
  return scopedStoreIds === null ? {} : { id: { in: scopedStoreIds } };
}
