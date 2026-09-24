import type { SuiteApp } from "@prisma/client";

/**
 * The six apps, their base URLs and their platform credentials
 * (API-CONTRACT §2.1, D-31).
 *
 * One bearer key and one HMAC secret per app per environment, read from the
 * environment and never from a merchant. Growzar authenticates as itself; an
 * app may not gate these on a plan.
 *
 * An app with no base URL or no credentials configured is simply not reachable
 * yet — which is the state most of them are in during Phase 1 — and every
 * caller has to cope with that rather than assume a working endpoint.
 */
export const SUITE_APPS = [
  "COURIERIFY",
  "FINANCIFY",
  "WHATKABOT",
  "PREVENTIFY",
  "RETAINIFY",
  "INVENTORIFY",
] as const satisfies readonly SuiteApp[];

export type AppCredentials = {
  app: SuiteApp;
  baseUrl: string;
  platformKey: string;
  signingSecret: string;
};

/**
 * Read at call time rather than at module load: the env file is reloaded when
 * the service restarts, and a key filled in on the box should not need a code
 * change to take effect.
 */
export function getAppCredentials(app: SuiteApp): AppCredentials | null {
  const baseUrl = process.env[`${app}_BASE_URL`]?.trim();
  const platformKey = process.env[`${app}_PLATFORM_KEY`]?.trim();
  const signingSecret = process.env[`${app}_SIGNING_SECRET`]?.trim();

  if (!baseUrl || !platformKey || !signingSecret) return null;

  return {
    app,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    platformKey,
    signingSecret,
  };
}

/** The apps that are actually reachable right now. */
export function configuredApps(): AppCredentials[] {
  return SUITE_APPS.map(getAppCredentials).filter(
    (credentials): credentials is AppCredentials => credentials !== null,
  );
}

/** The token issuer strings apps use in the claim token's `iss` (§10). */
export const APP_BY_ISSUER: Record<string, SuiteApp> = {
  courierify: "COURIERIFY",
  financify: "FINANCIFY",
  whatkabot: "WHATKABOT",
  preventify: "PREVENTIFY",
  retainify: "RETAINIFY",
  inventorify: "INVENTORIFY",
};
