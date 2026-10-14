import { describe, expect, it } from "vitest";

import { digestSubject, renderDigest, type DigestEmail } from "./render";

// Made-up store and figures.
const link = (label: string) => ({ href: "https://growzar.test/insights/i1/open?to=%2Forders&from=digest", label });
const email: DigestEmail = {
  recipientName: "Sana",
  organizationName: "Pilot <Org>",
  weekLabel: "Monday 19 October",
  homeUrl: "https://growzar.test/home",
  settingsUrl: "https://growzar.test/settings/digest",
  unsubscribeUrl: "https://growzar.test/digest/unsubscribe?t=abc.def",
  stores: [
    {
      name: "Test Store",
      rows: [
        {
          headline: `Kurta "Lawn" <b>Blue</b> comes back far more often`,
          figure: "PKR 12,400",
          line: "Counted by order.",
          link: link("See orders"),
          action: { href: "https://growzar.test/insights/i1/act?screen=preventify_offers&from=digest", label: "Install Preventify" },
        },
      ],
      app: { appName: "WhatKaBot", headline: "PKR 50,000 of returned orders were never confirmed", body: "WhatKaBot asks buyers to confirm.", link: link("Install WhatKaBot") },
    },
  ],
};

describe("renderDigest", () => {
  const out = renderDigest(email);

  it("escapes what came from a store", () => {
    expect(out.html).toContain("Kurta &quot;Lawn&quot; &lt;b&gt;Blue&lt;/b&gt;");
    expect(out.html).not.toContain("<b>Blue</b>");
    expect(out.html).toContain("Pilot &lt;Org&gt;");
  });

  it("links every row, action and app lead through the tracked routes", () => {
    expect(out.html).toContain("/insights/i1/open?to=%2Forders&amp;from=digest");
    expect(out.html).toContain("/insights/i1/act?screen=preventify_offers&amp;from=digest");
    expect(out.text).toContain("Install Preventify: https://growzar.test/insights/i1/act?screen=preventify_offers&from=digest");
  });

  it("carries the unsubscribe link in both parts", () => {
    expect(out.html).toContain("digest/unsubscribe?t=abc.def");
    expect(out.text).toContain("Unsubscribe: https://growzar.test/digest/unsubscribe?t=abc.def");
  });

  it("says amounts are what happened, not savings", () => {
    expect(out.text).toContain("Amounts are what happened, not what an app would save.");
  });
});

describe("digestSubject", () => {
  it("counts the rows and names a single store", () => {
    expect(digestSubject(email)).toBe("1 thing needs your attention at Test Store");
  });
  it("names no store when there are several, and marks a test", () => {
    const two = { stores: [email.stores[0]!, { ...email.stores[0]!, name: "Other" }], test: true };
    expect(digestSubject(two)).toBe("[Test] 2 things need your attention");
  });
  it("still has a subject with only an app lead", () => {
    expect(digestSubject({ stores: [{ ...email.stores[0]!, rows: [] }] })).toBe("Your week at Test Store");
  });
});
