import { describe, expect, it } from "vitest";

import { installOffer, isIos } from "./install-app";

const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const IPAD = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15";

describe("installOffer", () => {
  it("offers the browser's install where it fired beforeinstallprompt", () => {
    expect(installOffer({ standalone: false, hasPrompt: true, userAgent: ANDROID, maxTouchPoints: 5 })).toBe("prompt");
  });

  it("offers the Add to Home Screen how-to on an iPhone", () => {
    expect(installOffer({ standalone: false, hasPrompt: false, userAgent: IPHONE, maxTouchPoints: 5 })).toBe("ios");
  });

  it("offers nothing inside the installed app", () => {
    expect(installOffer({ standalone: true, hasPrompt: true, userAgent: ANDROID, maxTouchPoints: 5 })).toBeNull();
    expect(installOffer({ standalone: true, hasPrompt: false, userAgent: IPHONE, maxTouchPoints: 5 })).toBeNull();
  });

  it("offers nothing where the browser can't install and isn't iOS", () => {
    expect(installOffer({ standalone: false, hasPrompt: false, userAgent: ANDROID, maxTouchPoints: 5 })).toBeNull();
  });
});

describe("isIos", () => {
  it("knows an iPad that calls itself a Mac by its touch screen", () => {
    expect(isIos(IPAD, 5)).toBe(true);
    expect(isIos(IPAD, 0)).toBe(false);
  });
});
