import type { SuiteApp } from "@prisma/client";

import { getAppCredentials, type AppCredentials } from "./registry.server";
import { outboundHeaders } from "./signing.server";
import {
  allowRequest,
  recordFailure,
  recordSuccess,
} from "./circuit-breaker.server";

/**
 * The connector: one signed, retrying, circuit-broken HTTP call to a suite app.
 *
 * Lifted in substance from `salvage/lib/courierify/client.ts` and
 * `lib/financify/client.ts`, with the parts the contract replaced rebuilt
 * rather than ported:
 *
 *  - **Auth.** The salvaged clients took a merchant-pasted API key and
 *    decrypted it per request. The contract uses one platform credential per
 *    app (§2.1, D-31), plus a signature the bearer key cannot substitute for.
 *  - **`Retry-After`.** The salvaged client parsed it into
 *    `retryAfterSeconds` and then never read it: its only retry was a flat
 *    2-second wait on timeouts, and a 429 threw immediately. Here a 429 or 503
 *    with `Retry-After` waits exactly as long as it was asked to, and never
 *    less.
 *  - **Backoff.** Retries are exponential with jitter instead of one fixed
 *    2-second sleep, because a second failure usually means the app needs more
 *    time than the first one did, and because a herd of workers retrying in
 *    lockstep is how a struggling app is kept struggling.
 *  - **A circuit breaker**, which the salvaged clients had no concept of.
 *
 * The range-scaled timeout is kept: it was a sound idea. The contract's 10 s
 * for reads is the floor, widened for wide date ranges.
 */

const READ_TIMEOUT_MS = 10_000;
const WIDE_RANGE_TIMEOUT_MS = 45_000;
const MAX_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 500;
/**
 * However long an app asks us to wait, there is a point past which waiting is
 * worse than reporting the app as unavailable and coming back next cycle.
 */
const MAX_RETRY_AFTER_MS = 60_000;

export type AppRequestError = {
  ok: false;
  app: SuiteApp;
  reason:
    | "not_configured"
    | "circuit_open"
    | "unauthorized"
    | "rate_limited"
    | "client_error"
    | "server_error"
    | "timeout"
    | "network"
    | "bad_payload";
  status?: number;
  errorType?: string;
  message: string;
  retryAfterMs?: number;
};

export type AppRequestSuccess<T> = { ok: true; app: SuiteApp; data: T };
export type AppRequestResult<T> = AppRequestSuccess<T> | AppRequestError;

const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `Retry-After` is either a number of seconds or an HTTP date. Both are in the
 * wild; the salvaged client only understood the first and quietly produced NaN
 * for the second.
 */
export function parseRetryAfter(
  header: string | null,
  now = Date.now(),
): number | null {
  if (!header) return null;

  const seconds = Number(header.trim());
  if (Number.isFinite(seconds)) {
    return Math.max(0, Math.round(seconds * 1000));
  }

  const date = Date.parse(header);
  if (Number.isFinite(date)) {
    return Math.max(0, date - now);
  }

  return null;
}

/** Exponential with full jitter, so retries from many workers spread out. */
export function backoffDelay(attempt: number, random = Math.random): number {
  const ceiling = BASE_BACKOFF_MS * 2 ** (attempt - 1);
  return Math.round(random() * ceiling);
}

function timeoutFor(pathWithQuery: string): number {
  const query = pathWithQuery.split("?")[1];
  if (!query) return READ_TIMEOUT_MS;

  const params = new URLSearchParams(query);
  const start = params.get("startDate");
  const end = params.get("endDate");
  if (!start || !end) return READ_TIMEOUT_MS;

  const days =
    (Date.parse(end) - Date.parse(start)) / (1000 * 60 * 60 * 24);
  return Number.isFinite(days) && days > 7
    ? WIDE_RANGE_TIMEOUT_MS
    : READ_TIMEOUT_MS;
}

/**
 * Whether another attempt is worth making. A 4xx that is not a 429 means
 * Growzar asked a bad question and asking it again will get the same answer.
 */
function isRetryable(result: AppRequestError): boolean {
  return (
    result.reason === "rate_limited" ||
    result.reason === "server_error" ||
    result.reason === "timeout" ||
    result.reason === "network"
  );
}

/** Failures that say something about the app's health, for the breaker. */
function countsAgainstHealth(result: AppRequestError): boolean {
  return (
    result.reason === "server_error" ||
    result.reason === "timeout" ||
    result.reason === "network"
  );
}

async function attempt<T>(
  credentials: AppCredentials,
  options: {
    method: "GET" | "POST";
    pathWithQuery: string;
    shopDomain: string;
    body?: string;
  },
): Promise<AppRequestResult<T>> {
  const { app } = credentials;

  try {
    const response = await fetch(
      `${credentials.baseUrl}${options.pathWithQuery}`,
      {
        method: options.method,
        headers: outboundHeaders({
          platformKey: credentials.platformKey,
          signingSecret: credentials.signingSecret,
          shopDomain: options.shopDomain,
          method: options.method,
          pathWithQuery: options.pathWithQuery,
          body: options.body,
        }),
        body: options.body,
        signal: AbortSignal.timeout(timeoutFor(options.pathWithQuery)),
      },
    );

    if (response.ok) {
      try {
        return { ok: true, app, data: (await response.json()) as T };
      } catch {
        return {
          ok: false,
          app,
          reason: "bad_payload",
          status: response.status,
          message: "The app returned something that is not JSON.",
        };
      }
    }

    // §9: the app's error body names the failure. Its absence is itself
    // informative, so it is not papered over with a generic message.
    let errorType: string | undefined;
    let message = `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as {
        error?: string;
        errorType?: string;
      };
      errorType = body.errorType;
      if (body.error) message = body.error;
    } catch {
      /* no body, or not JSON */
    }

    const retryAfterMs =
      parseRetryAfter(response.headers.get("retry-after")) ?? undefined;

    if (response.status === 429) {
      return {
        ok: false,
        app,
        reason: "rate_limited",
        status: 429,
        errorType,
        message,
        retryAfterMs,
      };
    }

    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        app,
        reason: "unauthorized",
        status: response.status,
        errorType,
        message,
      };
    }

    if (response.status >= 500) {
      return {
        ok: false,
        app,
        reason: "server_error",
        status: response.status,
        errorType,
        message,
        retryAfterMs,
      };
    }

    return {
      ok: false,
      app,
      reason: "client_error",
      status: response.status,
      errorType,
      message,
    };
  } catch (error) {
    const timedOut =
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError");

    return {
      ok: false,
      app,
      reason: timedOut ? "timeout" : "network",
      message: error instanceof Error ? error.message : "Unknown network error",
    };
  }
}

/**
 * One request, with retries, `Retry-After` honoured, and the breaker consulted
 * and updated.
 */
export async function appRequest<T>(
  app: SuiteApp,
  options: {
    method?: "GET" | "POST";
    pathWithQuery: string;
    shopDomain: string;
    body?: unknown;
    credentials?: AppCredentials | null;
    /** Test seam: lets a test run the retry logic without real waiting. */
    wait?: (ms: number) => Promise<void>;
  },
): Promise<AppRequestResult<T>> {
  const credentials = options.credentials ?? getAppCredentials(app);
  if (!credentials) {
    return {
      ok: false,
      app,
      reason: "not_configured",
      message: `No base URL or credentials configured for ${app}.`,
    };
  }

  if (!allowRequest(app)) {
    return {
      ok: false,
      app,
      reason: "circuit_open",
      message: `${app} is failing; not calling it again yet.`,
    };
  }

  const wait = options.wait ?? sleep;
  const body =
    options.body === undefined ? undefined : JSON.stringify(options.body);

  let last: AppRequestError | null = null;

  for (let attemptNumber = 1; attemptNumber <= MAX_ATTEMPTS; attemptNumber += 1) {
    const result = await attempt<T>(credentials, {
      method: options.method ?? "GET",
      pathWithQuery: options.pathWithQuery,
      shopDomain: options.shopDomain,
      body,
    });

    if (result.ok) {
      recordSuccess(app);
      return result;
    }

    last = result;

    if (countsAgainstHealth(result)) {
      recordFailure(app);
    } else {
      // A 4xx is not ill health, but it does end a half-open probe.
      recordSuccess(app);
    }

    if (!isRetryable(result) || attemptNumber === MAX_ATTEMPTS) break;

    // An app that says how long to wait is obeyed, and never shortened. If it
    // asks for longer than we are willing to hold the cycle open, we stop and
    // come back on the next one rather than sleeping through it.
    if (result.retryAfterMs !== undefined) {
      if (result.retryAfterMs > MAX_RETRY_AFTER_MS) break;
      await wait(result.retryAfterMs);
    } else {
      await wait(backoffDelay(attemptNumber));
    }
  }

  return (
    last ?? {
      ok: false,
      app,
      reason: "network",
      message: "No attempt was made.",
    }
  );
}

export const CLIENT_SETTINGS = {
  READ_TIMEOUT_MS,
  WIDE_RANGE_TIMEOUT_MS,
  MAX_ATTEMPTS,
  BASE_BACKOFF_MS,
  MAX_RETRY_AFTER_MS,
};
