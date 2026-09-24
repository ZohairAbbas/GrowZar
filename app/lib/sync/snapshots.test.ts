import { describe, expect, it } from "vitest";

import { canonicalize, contentHashOf } from "./snapshots.server";

/**
 * The hash is the whole of defect 2's fix, so it gets tested on its own: the
 * old hub's change detector compared a hand-written list of fields, costs were
 * not on the list, and a settlement correction that changed only the fee
 * produced no new version.
 */
describe("canonicalize", () => {
  it("ignores key order", () => {
    expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }));
  });

  it("ignores key order at every depth", () => {
    expect(canonicalize({ money: { amount: "10.00", currency: "PKR" } })).toBe(
      canonicalize({ money: { currency: "PKR", amount: "10.00" } }),
    );
  });

  it("keeps array order, which is meaningful", () => {
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
  });

  it("treats an undefined value as an absent key", () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe(canonicalize({ a: 1 }));
  });
});

describe("contentHashOf", () => {
  it("is stable across key order", () => {
    expect(contentHashOf({ orderId: "1", fee: "10.00" })).toBe(
      contentHashOf({ fee: "10.00", orderId: "1" }),
    );
  });

  it("notices a late fee correction", () => {
    // Defect 2, stated as the case it actually broke on: everything about the
    // order is identical except the courier's booked fee, corrected weeks
    // later. This must produce a different hash, and therefore a new version.
    const before = {
      orderId: "5123456789012",
      status: "delivered",
      total: { amount: "4500.00", currency: "PKR" },
      courierFee: { amount: "250.00", currency: "PKR" },
    };
    const after = { ...before, courierFee: { amount: "310.00", currency: "PKR" } };

    expect(contentHashOf(after)).not.toBe(contentHashOf(before));
  });

  it("notices a change anywhere, including fields nobody thought about", () => {
    const base = { orderId: "1", nested: { deep: { value: 1 } } };
    const changed = { orderId: "1", nested: { deep: { value: 2 } } };

    expect(contentHashOf(changed)).not.toBe(contentHashOf(base));
  });

  it("does not change when nothing changed", () => {
    const payload = { orderId: "1", lines: [{ sku: "A", qty: 2 }] };
    expect(contentHashOf(structuredClone(payload))).toBe(contentHashOf(payload));
  });
});
