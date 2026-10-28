import { describe, expect, it } from "vitest";

import { keyBytes, notificationState, sameKey } from "./browser";

const chrome = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/141.0 Mobile Safari/537.36";
const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1";
const base = { userAgent: chrome, maxTouchPoints: 5, standalone: false, supported: true, permission: "default" as const, subscribed: false };

describe("Settings' Notifications switch on this device", () => {
  it("asks an iPhone to install Growzar first, and works once it runs installed", () => {
    expect(notificationState({ ...base, userAgent: iphone, supported: false })).toBe("ios_install");
    expect(notificationState({ ...base, userAgent: iphone, standalone: true })).toBe("off");
  });
  it("says when the browser can't, or when notifications are blocked", () => {
    expect(notificationState({ ...base, supported: false })).toBe("unsupported");
    expect(notificationState({ ...base, permission: "denied" })).toBe("blocked");
  });
  it("is on only with a subscription and permission granted", () => {
    expect(notificationState(base)).toBe("off");
    expect(notificationState({ ...base, subscribed: true, permission: "granted" })).toBe("on");
    expect(notificationState({ ...base, subscribed: true, permission: "default" })).toBe("off");
  });
});

describe("the VAPID key in the browser", () => {
  it("decodes URL-safe base64, and tells an older key apart", () => {
    expect([...keyBytes("AQID_-8")]).toEqual([1, 2, 3, 255, 239]);
    expect(sameKey(keyBytes("AQID_-8").buffer, "AQID_-8")).toBe(true);
    expect(sameKey(keyBytes("AQID_-4").buffer, "AQID_-8")).toBe(false);
    expect(sameKey(null, "AQID_-8")).toBe(false);
  });
});
