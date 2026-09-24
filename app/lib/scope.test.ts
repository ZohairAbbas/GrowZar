import { describe, expect, it } from "vitest";

import { isStoreInScope, resolveScopedStoreIds, storeScopeFilter } from "./scope";

describe("resolveScopedStoreIds", () => {
  it("means all stores unless scoping was explicitly turned on", () => {
    expect(resolveScopedStoreIds(true, [])).toBeNull();
    expect(resolveScopedStoreIds(true, [{ storeId: "a" }])).toBeNull();
  });

  it("treats a null column as all stores, not none", () => {
    // The column is nullable. A member row that predates scoping, or one
    // written by a Better Auth path that does not know the column, reads null
    // — and must not lose access to their own stores because of it.
    expect(resolveScopedStoreIds(null, [])).toBeNull();
    expect(resolveScopedStoreIds(undefined, [])).toBeNull();
  });

  it("narrows to exactly the named stores when scoping is on", () => {
    expect(
      resolveScopedStoreIds(false, [{ storeId: "a" }, { storeId: "b" }]),
    ).toEqual(["a", "b"]);
  });

  it("lets scoping to nothing mean nothing", () => {
    // Deliberate state: scoped on, no stores ticked. Distinct from "all".
    expect(resolveScopedStoreIds(false, [])).toEqual([]);
  });
});

describe("isStoreInScope", () => {
  it("allows everything when scope is all", () => {
    expect(isStoreInScope(null, "anything")).toBe(true);
  });

  it("allows only what is named", () => {
    expect(isStoreInScope(["a"], "a")).toBe(true);
    expect(isStoreInScope(["a"], "b")).toBe(false);
    expect(isStoreInScope([], "a")).toBe(false);
  });
});

describe("storeScopeFilter", () => {
  it("adds no condition for an unscoped member", () => {
    expect(storeScopeFilter(null)).toEqual({});
  });

  it("restricts to the scoped ids", () => {
    expect(storeScopeFilter(["a", "b"])).toEqual({ id: { in: ["a", "b"] } });
  });

  it("restricts to nothing for a member scoped to no stores", () => {
    // `{ id: { in: [] } }` matches no row, which is the point.
    expect(storeScopeFilter([])).toEqual({ id: { in: [] } });
  });
});
