import { describe, expect, it } from "vitest";

import {
  SIGNATURE_SKEW_MS,
  outboundHeaders,
  sign,
  signingPayload,
  verifySignature,
} from "./signing.server";

const SECRET = "a-shared-secret";
const NOW = 1_790_000_000_000;

const verifyOutbound = (headers: Headers, overrides: Partial<Parameters<typeof verifySignature>[0]> = {}) =>
  verifySignature({
    secret: SECRET,
    signature: headers.get("X-Growzar-Signature"),
    timestamp: headers.get("X-Growzar-Timestamp"),
    method: "GET",
    pathWithQuery: "/api/v1/growzar/status?shop=acme.myshopify.com",
    body: "",
    now: NOW,
    ...overrides,
  });

describe("request signing", () => {
  it("round-trips what Growzar sends", () => {
    const headers = outboundHeaders({
      platformKey: "key",
      signingSecret: SECRET,
      shopDomain: "acme.myshopify.com",
      method: "GET",
      pathWithQuery: "/api/v1/growzar/status?shop=acme.myshopify.com",
      now: NOW,
    });

    expect(headers.get("Authorization")).toBe("Bearer key");
    expect(headers.get("X-Growzar-Shop")).toBe("acme.myshopify.com");
    expect(verifyOutbound(headers)).toEqual({ ok: true });
  });

  it("covers the query string, not just the path", () => {
    const headers = outboundHeaders({
      platformKey: "key",
      signingSecret: SECRET,
      shopDomain: "acme.myshopify.com",
      method: "GET",
      pathWithQuery: "/api/v1/growzar/status?shop=acme.myshopify.com",
      now: NOW,
    });

    // Swapping the shop must break the signature, or the tenant of a request
    // could be changed in flight.
    expect(
      verifyOutbound(headers, {
        pathWithQuery: "/api/v1/growzar/status?shop=victim.myshopify.com",
      }),
    ).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("covers the body", () => {
    const headers = outboundHeaders({
      platformKey: "key",
      signingSecret: SECRET,
      shopDomain: "acme.myshopify.com",
      method: "POST",
      pathWithQuery: "/api/v1/events",
      body: '{"eventId":"1"}',
      now: NOW,
    });

    expect(
      verifyOutbound(headers, {
        method: "POST",
        pathWithQuery: "/api/v1/events",
        body: '{"eventId":"2"}',
      }),
    ).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("refuses a signature from the wrong secret", () => {
    const headers = outboundHeaders({
      platformKey: "key",
      signingSecret: "someone-elses-secret",
      shopDomain: "acme.myshopify.com",
      method: "GET",
      pathWithQuery: "/api/v1/growzar/status?shop=acme.myshopify.com",
      now: NOW,
    });

    expect(verifyOutbound(headers)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("holds the 5-minute window in both directions", () => {
    const payload = signingPayload({
      timestamp: NOW,
      method: "GET",
      pathWithQuery: "/x",
      body: "",
    });
    const signature = sign(SECRET, payload);

    const at = (now: number) =>
      verifySignature({
        secret: SECRET,
        signature,
        timestamp: String(NOW),
        method: "GET",
        pathWithQuery: "/x",
        body: "",
        now,
      });

    expect(at(NOW + SIGNATURE_SKEW_MS - 1).ok).toBe(true);
    expect(at(NOW + SIGNATURE_SKEW_MS + 1)).toEqual({
      ok: false,
      reason: "timestamp_out_of_range",
    });
    // A future timestamp is as wrong as an old one: a clock nobody controls
    // is not a reason to accept a request.
    expect(at(NOW - SIGNATURE_SKEW_MS - 1)).toEqual({
      ok: false,
      reason: "timestamp_out_of_range",
    });
  });

  it("names what is missing rather than failing vaguely", () => {
    const base = {
      secret: SECRET,
      method: "GET",
      pathWithQuery: "/x",
      body: "",
      now: NOW,
    };

    expect(
      verifySignature({ ...base, signature: null, timestamp: String(NOW) }),
    ).toEqual({ ok: false, reason: "missing_signature" });

    expect(verifySignature({ ...base, signature: "sha256=x", timestamp: null })).toEqual({
      ok: false,
      reason: "missing_timestamp",
    });

    expect(
      verifySignature({ ...base, signature: "sha256=x", timestamp: "not-a-number" }),
    ).toEqual({ ok: false, reason: "timestamp_out_of_range" });
  });

  it("does not throw on a short signature", () => {
    // timingSafeEqual throws on a length mismatch; a truncated header must be
    // an ordinary rejection, not a 500.
    expect(
      verifySignature({
        secret: SECRET,
        signature: "sha256=ab",
        timestamp: String(NOW),
        method: "GET",
        pathWithQuery: "/x",
        body: "",
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: "bad_signature" });
  });
});
