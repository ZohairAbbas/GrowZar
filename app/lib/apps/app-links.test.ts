import { describe, expect, it } from "vitest";

import { actionFor, actionHref, isScreenKey } from "./app-links";

describe("app links (G-GZR6-2)", () => {
  it("opens the fixing screen when the app is connected, else offers the install", () => {
    expect(actionFor("retainify_flows", new Set(["RETAINIFY"]))).toEqual({ screen: "retainify_flows", label: "Set up a cart reminder in Retainify", install: false });
    expect(actionFor("preventify_verification", new Set(["COURIERIFY"]))).toEqual({ screen: "preventify_verification", label: "Install Preventify", install: true });
  });

  it("uses the admin handle, which can differ from the App Store slug", () => {
    expect(actionHref("retainify_flows", new Set(["RETAINIFY"]), "example-shop.myshopify.com")).toBe("https://admin.shopify.com/store/example-shop/apps/retainify-1/app/flows");
    expect(actionHref("retainify_flows", new Set(), "example-shop.myshopify.com")).toBe("https://apps.shopify.com/retainify");
    expect(actionHref("inventorify_reorder", new Set(["INVENTORIFY"]), "example-shop.myshopify.com")).toBe("https://admin.shopify.com/store/example-shop/apps/inventorify-5/app/purchase-orders/new");
    expect(actionHref("inventorify_reorder", new Set(), "example-shop.myshopify.com")).toBe("https://apps.shopify.com/inventorify-8");
  });

  it("refuses unknown screens and malformed shops rather than guessing a link", () => {
    for (const k of ["nope", "constructor", "__proto__", "", null]) expect(isScreenKey(k)).toBe(false);
    expect(actionHref("courierify_ndr", new Set(["COURIERIFY"]), "evil.com/x?.myshopify.com")).toBeNull();
  });
});
