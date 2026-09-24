import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Request signing, API-CONTRACT §2.1 and §2.2.
 *
 *   X-Growzar-Signature: sha256=HMAC(secret, "<timestamp>.<method> <path+query>.<raw body>")
 *   X-Growzar-Timestamp: ms epoch, 5-minute skew limit, compared timing-safe
 *
 * The bearer key alone is never sufficient in either direction. The same
 * construction signs Growzar's outbound calls (§2.1) and verifies apps'
 * inbound events (§2.2), so it lives in one place and cannot drift between
 * the two.
 */
export const SIGNATURE_SKEW_MS = 5 * 60 * 1000;

/** The exact bytes both sides hash. Any difference here is a failed request. */
export function signingPayload(options: {
  timestamp: number;
  method: string;
  pathWithQuery: string;
  body: string;
}): string {
  const { timestamp, method, pathWithQuery, body } = options;
  return `${timestamp}.${method.toUpperCase()} ${pathWithQuery}.${body}`;
}

export function sign(secret: string, payload: string): string {
  return `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
}

/**
 * Headers for an outbound call to an app.
 *
 * `pathWithQuery` is the path as it will appear on the wire, query string and
 * all — signing the path without its query would let anyone change a
 * `shopDomain` parameter without breaking the signature.
 */
export function outboundHeaders(options: {
  platformKey: string;
  signingSecret: string;
  shopDomain: string;
  method: string;
  pathWithQuery: string;
  body?: string;
  now?: number;
}): Headers {
  const timestamp = options.now ?? Date.now();
  const body = options.body ?? "";

  const headers = new Headers({
    Authorization: `Bearer ${options.platformKey}`,
    "X-Growzar-Shop": options.shopDomain,
    "X-Growzar-Timestamp": String(timestamp),
    "X-Growzar-Signature": sign(
      options.signingSecret,
      signingPayload({
        timestamp,
        method: options.method,
        pathWithQuery: options.pathWithQuery,
        body,
      }),
    ),
    Accept: "application/json",
  });

  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }

  return headers;
}

export type VerificationFailure =
  | "missing_signature"
  | "missing_timestamp"
  | "timestamp_out_of_range"
  | "bad_signature";

/**
 * Verify an inbound signature (§2.2). Used by the event relay in G-GZR-5, and
 * here so both directions are written and tested together.
 *
 * The timestamp is checked before the HMAC because a replay of a genuinely
 * signed request is the cheaper attack, and it is checked in both directions:
 * a far-future timestamp is as wrong as an old one.
 */
export function verifySignature(options: {
  secret: string;
  signature: string | null;
  timestamp: string | null;
  method: string;
  pathWithQuery: string;
  body: string;
  now?: number;
}): { ok: true } | { ok: false; reason: VerificationFailure } {
  const { secret, signature, timestamp } = options;

  if (!signature) return { ok: false, reason: "missing_signature" };
  if (!timestamp) return { ok: false, reason: "missing_timestamp" };

  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt)) {
    return { ok: false, reason: "timestamp_out_of_range" };
  }

  const now = options.now ?? Date.now();
  if (Math.abs(now - sentAt) > SIGNATURE_SKEW_MS) {
    return { ok: false, reason: "timestamp_out_of_range" };
  }

  const expected = sign(
    secret,
    signingPayload({
      timestamp: sentAt,
      method: options.method,
      pathWithQuery: options.pathWithQuery,
      body: options.body,
    }),
  );

  const a = Buffer.from(expected);
  const b = Buffer.from(signature);

  // timingSafeEqual throws on a length mismatch, which would itself leak the
  // expected length, so the lengths are compared first and both paths end in
  // the same answer.
  if (a.length !== b.length) return { ok: false, reason: "bad_signature" };
  if (!timingSafeEqual(a, b)) return { ok: false, reason: "bad_signature" };

  return { ok: true };
}
