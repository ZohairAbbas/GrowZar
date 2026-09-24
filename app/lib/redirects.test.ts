import { describe, expect, it } from "vitest";

import { safeRedirectPath } from "./redirects";

describe("safeRedirectPath", () => {
  it("keeps a path on this host", () => {
    expect(safeRedirectPath("/settings/team")).toBe("/settings/team");
    expect(safeRedirectPath("/orders?store=abc&page=2")).toBe(
      "/orders?store=abc&page=2",
    );
  });

  it("refuses anything that leaves this host", () => {
    for (const hostile of [
      "//evil.example",
      "///evil.example",
      "https://evil.example",
      "http://evil.example",
      "/\\evil.example",
      "/settings\\@evil.example",
      "javascript:alert(1)",
    ]) {
      expect(safeRedirectPath(hostile), hostile).toBe("/");
    }
  });

  it("falls back when there is nothing usable", () => {
    expect(safeRedirectPath(null)).toBe("/");
    expect(safeRedirectPath(undefined)).toBe("/");
    expect(safeRedirectPath("")).toBe("/");
    expect(safeRedirectPath("settings")).toBe("/");
  });

  it("takes the caller's fallback", () => {
    expect(safeRedirectPath(null, "/organizations/new")).toBe(
      "/organizations/new",
    );
  });
});
