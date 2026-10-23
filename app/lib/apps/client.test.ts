import { afterEach, describe, expect, it, vi } from "vitest";

import { appRequest, backoffDelay, parseRetryAfter, CLIENT_SETTINGS } from "./client.server";
import {
  BREAKER_SETTINGS,
  allowRequest,
  breakerState,
  recordFailure,
  recordSuccess,
  resetBreakers,
} from "./circuit-breaker.server";

describe("parseRetryAfter", () => {
  // The salvaged client did `parseInt(header, 10)` and then never used the
  // result. It also produced NaN for the HTTP-date form, which is legal and in
  // the wild.
  it("reads the seconds form", () => {
    expect(parseRetryAfter("30")).toBe(30_000);
    expect(parseRetryAfter(" 2 ")).toBe(2_000);
    expect(parseRetryAfter("0")).toBe(0);
  });

  it("reads the HTTP-date form", () => {
    const now = Date.parse("2026-09-24T10:00:00Z");
    expect(parseRetryAfter("Thu, 24 Sep 2026 10:00:45 GMT", now)).toBe(45_000);
  });

  it("never returns a negative wait for a date already past", () => {
    const now = Date.parse("2026-09-24T10:00:00Z");
    expect(parseRetryAfter("Thu, 24 Sep 2026 09:59:00 GMT", now)).toBe(0);
  });

  it("returns null when there is nothing to read", () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("soon please")).toBeNull();
  });
});

describe("backoffDelay", () => {
  it("grows exponentially", () => {
    // Full jitter, so the ceiling is what is asserted.
    const ceilingAt = (attempt: number) =>
      backoffDelay(attempt, () => 1);

    expect(ceilingAt(1)).toBe(CLIENT_SETTINGS.BASE_BACKOFF_MS);
    expect(ceilingAt(2)).toBe(CLIENT_SETTINGS.BASE_BACKOFF_MS * 2);
    expect(ceilingAt(3)).toBe(CLIENT_SETTINGS.BASE_BACKOFF_MS * 4);
  });

  it("jitters down to zero, so workers do not retry in lockstep", () => {
    expect(backoffDelay(3, () => 0)).toBe(0);
  });
});

describe("circuit breaker", () => {
  it("opens only after a run of failures", () => {
    resetBreakers();

    for (let i = 1; i < BREAKER_SETTINGS.FAILURE_THRESHOLD; i += 1) {
      recordFailure("COURIERIFY");
      expect(breakerState("COURIERIFY")).toBe("closed");
    }

    recordFailure("COURIERIFY");
    expect(breakerState("COURIERIFY")).toBe("open");
    expect(allowRequest("COURIERIFY")).toBe(false);
  });

  it("is per app", () => {
    resetBreakers();
    for (let i = 0; i < BREAKER_SETTINGS.FAILURE_THRESHOLD; i += 1) {
      recordFailure("COURIERIFY");
    }

    expect(breakerState("COURIERIFY")).toBe("open");
    expect(breakerState("FINANCIFY")).toBe("closed");
    expect(allowRequest("FINANCIFY")).toBe(true);
  });

  it("lets exactly one probe through when half-open", () => {
    resetBreakers();
    const openedAt = 1_790_000_000_000;

    for (let i = 0; i < BREAKER_SETTINGS.FAILURE_THRESHOLD; i += 1) {
      recordFailure("COURIERIFY", openedAt);
    }

    const afterCooldown = openedAt + BREAKER_SETTINGS.COOLDOWN_MS + 1;
    expect(breakerState("COURIERIFY", afterCooldown)).toBe("half-open");

    expect(allowRequest("COURIERIFY", afterCooldown)).toBe(true);
    // The second caller waits for the probe's answer instead of piling on.
    expect(allowRequest("COURIERIFY", afterCooldown)).toBe(false);
  });

  it("closes on a success and forgets the failures", () => {
    resetBreakers();
    for (let i = 0; i < BREAKER_SETTINGS.FAILURE_THRESHOLD; i += 1) {
      recordFailure("COURIERIFY");
    }
    recordSuccess("COURIERIFY");

    expect(breakerState("COURIERIFY")).toBe("closed");
    expect(allowRequest("COURIERIFY")).toBe(true);
  });
});

describe("appRequest for a write", () => {
  const credentials = { app: "INVENTORIFY" as const, baseUrl: "https://inv.test", platformKey: "k", signingSecret: "s" };
  afterEach(() => {
    vi.unstubAllGlobals();
    resetBreakers();
  });

  it("sends the extra headers alongside the signed ones, and stops after the attempts it was given", async () => {
    const seen: Headers[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      seen.push(new Headers(init.headers));
      return new Response(JSON.stringify({ error: "down", errorType: "internal_error" }), { status: 500 });
    });
    const r = await appRequest("INVENTORIFY", {
      method: "POST",
      pathWithQuery: "/api/v1/growzar/costs/confirm",
      shopDomain: "a.myshopify.com",
      body: { previewId: "p" },
      headers: { "Idempotency-Key": "key-1", "X-Growzar-User": "u1" },
      maxAttempts: 1,
      credentials,
      wait: async () => undefined,
    });
    expect(r).toMatchObject({ ok: false, reason: "server_error", errorType: "internal_error" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.get("Idempotency-Key")).toBe("key-1");
    expect(seen[0]!.get("X-Growzar-User")).toBe("u1");
    expect(seen[0]!.get("X-Growzar-Signature")).toBeTruthy();
    expect(seen[0]!.get("X-Growzar-Shop")).toBe("a.myshopify.com");
  });
});
