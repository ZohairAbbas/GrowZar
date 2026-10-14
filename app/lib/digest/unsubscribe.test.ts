import { describe, expect, it } from "vitest";

import { readUnsubscribeToken, unsubscribeToken } from "./unsubscribe.server";

describe("unsubscribe token", () => {
  it("names the member it was made for", () => {
    expect(readUnsubscribeToken(unsubscribeToken("member-1"))).toBe("member-1");
  });

  it("rejects a token pointed at another member", () => {
    const [, sig] = unsubscribeToken("member-1").split(".");
    expect(readUnsubscribeToken(`${Buffer.from("member-2").toString("base64url")}.${sig}`)).toBeNull();
  });

  it("rejects junk", () => {
    expect(readUnsubscribeToken(null)).toBeNull();
    expect(readUnsubscribeToken("")).toBeNull();
    expect(readUnsubscribeToken("abc")).toBeNull();
    expect(readUnsubscribeToken("abc.def")).toBeNull();
  });
});
