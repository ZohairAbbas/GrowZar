import type { SuiteApp } from "@prisma/client";

import { configuredApps } from "../apps/registry.server";
import { verifySignature } from "../apps/signing.server";

/**
 * Verifying an inbound event (API-CONTRACT §2.2, §7).
 *
 * **A gap in the contract, handled rather than papered over.** §2.2 says the
 * app→Growzar direction "uses the same signature construction with the same
 * per-app secret", but §7 never says how Growzar is meant to tell *which* app
 * sent an event: the envelope has no issuer field, and the inbound direction
 * has no equivalent of §2.1's bearer key. So Growzar identifies the sender by
 * finding which configured app's secret validates the signature.
 *
 * That works against the contract exactly as written, needs nothing new from
 * any app, and is cheap — six HMACs of a small body. It is not free of
 * downsides: it cannot distinguish two apps sharing a secret, and it does a
 * little work on an unsigned request. Both are acceptable; sharing a secret
 * between apps is already a violation of §2.3, and the work is bounded.
 *
 * `X-Growzar-App` would be better and is a one-line change on both sides. It
 * is in the Phase 1 report as a proposed v2 addition rather than invented
 * here, because the contract wins and a conflict gets reported (pack rule #5).
 */
export type VerifiedSender = { app: SuiteApp };

export type VerifyFailure =
  | "missing_signature"
  | "missing_timestamp"
  | "timestamp_out_of_range"
  | "unknown_sender";

/**
 * Every configured app's secret is tried against the signature.
 *
 * All candidates are checked even after one matches. Stopping early would make
 * the response time depend on which app sent it, and the cost of not stopping
 * is a handful of hashes.
 */
export function identifySender(options: {
  signature: string | null;
  timestamp: string | null;
  method: string;
  pathWithQuery: string;
  body: string;
  now?: number;
}): { ok: true; sender: VerifiedSender } | { ok: false; reason: VerifyFailure } {
  if (!options.signature) return { ok: false, reason: "missing_signature" };
  if (!options.timestamp) return { ok: false, reason: "missing_timestamp" };

  let sawTimestampProblem = false;
  let matched: SuiteApp | null = null;

  for (const credentials of configuredApps()) {
    const result = verifySignature({
      secret: credentials.signingSecret,
      signature: options.signature,
      timestamp: options.timestamp,
      method: options.method,
      pathWithQuery: options.pathWithQuery,
      body: options.body,
      now: options.now,
    });

    if (result.ok) {
      if (matched === null) matched = credentials.app;
      continue;
    }

    if (result.reason === "timestamp_out_of_range") {
      sawTimestampProblem = true;
    }
  }

  if (matched) return { ok: true, sender: { app: matched } };

  // A stale timestamp is reported as itself rather than as "unknown sender":
  // the app's clock drifting is a different thing to fix from a wrong secret,
  // and telling them apart is the difference between a five-minute fix and an
  // afternoon.
  if (sawTimestampProblem) {
    return { ok: false, reason: "timestamp_out_of_range" };
  }

  return { ok: false, reason: "unknown_sender" };
}
