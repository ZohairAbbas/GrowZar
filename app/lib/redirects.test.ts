import { describe, expect, it } from "vitest";

import { appPathWithSearch, appUrl, safeRedirectPath } from "./redirects";

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

describe("appUrl: the page a request is for, not React Router's data endpoint", () => {
  it("strips the .data suffix of a client-side navigation", () => {
    expect(appUrl("https://portal.growzar.com/finance.data?_routes=routes%2Fshell%2Csection-finance").pathname).toBe("/finance");
  });

  it("strips the trailing-slash form /_.data", () => {
    expect(appUrl("https://portal.growzar.com/_.data").pathname).toBe("/");
  });

  it("keeps the page's own query and drops _routes", () => {
    expect(appPathWithSearch("https://portal.growzar.com/finance.data?days=90&_routes=x")).toBe("/finance?days=90");
  });

  it("leaves a document request alone", () => {
    expect(appPathWithSearch("https://portal.growzar.com/orders?days=7")).toBe("/orders?days=7");
  });

  it("does not strip .data from the middle of a path", () => {
    expect(appUrl("https://portal.growzar.com/stores/a.data.b").pathname).toBe("/stores/a.data.b");
  });
});

