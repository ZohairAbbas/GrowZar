import type { SuiteApp } from "@prisma/client";

import { getAppCredentials, type AppCredentials } from "./registry.server";
import { outboundHeaders } from "./signing.server";

/**
 * `GET /api/v1/growzar/status` (API-CONTRACT §11).
 *
 * Growzar asks every app whether it is installed on a shop, and what it can do
 * for that shop this release. The answer decides whether a section is open,
 * locked, or in reconnect mode (D-04, D-16, D-17).
 *
 * Reads time out at 10 s (§2). The retry policy, backoff and circuit breaker
 * are G-GZR-4; what is here is the single call, made safely enough that a
 * dead app cannot hang a claim.
 */
export const STATUS_PATH = "/api/v1/growzar/status";
const READ_TIMEOUT_MS = 10_000;

export type AppStatus = {
  installed: boolean;
  appVersion: string | null;
  shop: string | null;
  capabilities: string[];
  planRelevantFeatures: string[];
};

export type StatusResult =
  | { app: SuiteApp; ok: true; status: AppStatus }
  | {
      app: SuiteApp;
      ok: false;
      reason: "not_configured" | "http_error" | "bad_payload" | "unreachable";
      detail?: string;
    };

export async function fetchAppStatus(
  app: SuiteApp,
  shopDomain: string,
  credentials?: AppCredentials | null,
): Promise<StatusResult> {
  const creds = credentials ?? getAppCredentials(app);
  if (!creds) return { app, ok: false, reason: "not_configured" };

  const pathWithQuery = `${STATUS_PATH}?shop=${encodeURIComponent(shopDomain)}`;

  try {
    const response = await fetch(`${creds.baseUrl}${pathWithQuery}`, {
      method: "GET",
      headers: outboundHeaders({
        platformKey: creds.platformKey,
        signingSecret: creds.signingSecret,
        shopDomain,
        method: "GET",
        pathWithQuery,
      }),
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });

    if (!response.ok) {
      return {
        app,
        ok: false,
        reason: "http_error",
        detail: String(response.status),
      };
    }

    const body = (await response.json()) as Partial<AppStatus>;

    // `installed` must be stated. An app that omits it is not saying "no", it
    // is saying something Growzar cannot act on, and guessing either way would
    // be wrong — a guessed `true` invents a connection, a guessed `false`
    // would later look like an uninstall.
    if (typeof body.installed !== "boolean") {
      return { app, ok: false, reason: "bad_payload", detail: "installed" };
    }

    return {
      app,
      ok: true,
      status: {
        installed: body.installed,
        appVersion: typeof body.appVersion === "string" ? body.appVersion : null,
        shop: typeof body.shop === "string" ? body.shop.toLowerCase() : null,
        capabilities: Array.isArray(body.capabilities)
          ? body.capabilities.filter((c): c is string => typeof c === "string")
          : [],
        planRelevantFeatures: Array.isArray(body.planRelevantFeatures)
          ? body.planRelevantFeatures.filter(
              (f): f is string => typeof f === "string",
            )
          : [],
      },
    };
  } catch (error) {
    return {
      app,
      ok: false,
      reason: "unreachable",
      detail: error instanceof Error ? error.name : "unknown",
    };
  }
}
