import webpush from "web-push";

import { subscriptionOutcome } from "./rules";

/**
 * One push to one browser. `web-push` encrypts the payload and signs the
 * VAPID header; the request itself goes through fetch, so a test can point it
 * at a local push service and read what arrived.
 */

export type Vapid = { publicKey: string; privateKey: string; subject: string };
export type Target = { endpoint: string; p256dh: string; auth: string };
export type Delivery = { outcome: "delivered" | "gone" | "failed"; status: number | null; error: string | null };

/** How long a push service keeps it for a phone that is off: past that, a finding may have moved on. */
export const PUSH_TTL_SECONDS = 8 * 60 * 60;
const TIMEOUT_MS = 10_000;

export async function deliver(target: Target, payload: object, vapid: Vapid): Promise<Delivery> {
  let request: webpush.RequestDetails;
  try {
    request = webpush.generateRequestDetails(
      { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
      JSON.stringify(payload),
      { vapidDetails: vapid, TTL: PUSH_TTL_SECONDS, contentEncoding: "aes128gcm" },
    );
  } catch (error) {
    // Keys a browser would never hand out: the subscription can't be used.
    return { outcome: "gone", status: null, error: `keys: ${error instanceof Error ? error.message : "unreadable"}`.slice(0, 300) };
  }
  try {
    const response = await fetch(request.endpoint, {
      method: request.method,
      headers: request.headers as Record<string, string>,
      body: request.body ? new Uint8Array(request.body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const outcome = subscriptionOutcome(response.status);
    return { outcome, status: response.status, error: outcome === "delivered" ? null : `${response.status} ${(await response.text().catch(() => "")).slice(0, 200)}`.trim() };
  } catch (error) {
    return { outcome: "failed", status: null, error: (error instanceof Error ? error.message : "network").slice(0, 300) };
  }
}
