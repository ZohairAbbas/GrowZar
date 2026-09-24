import { errors, jwtVerify } from "jose";
import type { SuiteApp } from "@prisma/client";

import { prisma } from "./db.server";
import { APP_BY_ISSUER, getAppCredentials } from "./apps/registry.server";

/**
 * The "Open in Growzar" claim token (D-10, API-CONTRACT §10).
 *
 * The app mints it from its own verified Shopify session, so shop ownership is
 * proven by the app and the merchant never types anything. Growzar verifies
 * signature, audience, expiry and single use of `jti`.
 *
 * The token is never logged, never put in a redirect Growzar constructs, and
 * never stored. What survives verification is a PendingClaim row with no
 * secret in it.
 */

export type ClaimTokenClaims = {
  app: SuiteApp;
  shopDomain: string;
  email: string;
  shopifyUserId: string | null;
  isStoreOwner: boolean;
  locale: string | null;
  jti: string;
  expiresAt: Date;
};

export type ClaimFailure =
  | "malformed"
  | "unknown_issuer"
  | "app_not_configured"
  | "bad_signature"
  | "expired"
  | "wrong_audience"
  | "missing_claims"
  | "already_used";

export type ClaimResult =
  | { ok: true; claims: ClaimTokenClaims }
  | { ok: false; reason: ClaimFailure };

/**
 * Read `iss` without trusting it, only to pick which secret to verify with.
 * Nothing from an unverified token is used for anything else.
 */
function peekIssuer(token: string): string | null {
  const [, payload] = token.split(".");
  if (!payload) return null;
  try {
    const decoded = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as { iss?: unknown };
    return typeof decoded.iss === "string" ? decoded.iss : null;
  } catch {
    return null;
  }
}

/** Verify the token. Does not consume it — see `consumeClaimToken`. */
export async function verifyClaimToken(token: string): Promise<ClaimResult> {
  const issuer = peekIssuer(token);
  if (!issuer) return { ok: false, reason: "malformed" };

  const app = APP_BY_ISSUER[issuer.toLowerCase()];
  if (!app) return { ok: false, reason: "unknown_issuer" };

  const credentials = getAppCredentials(app);
  if (!credentials) return { ok: false, reason: "app_not_configured" };

  let payload;
  try {
    ({ payload } = await jwtVerify(
      token,
      new TextEncoder().encode(credentials.signingSecret),
      {
        algorithms: ["HS256"],
        audience: "growzar",
        issuer,
        // The contract fixes exp at iat + 300. jose enforces exp on its own;
        // this refuses a token whose lifetime is longer than the contract
        // allows, so an app that quietly starts minting day-long tokens is
        // caught here rather than trusted.
        maxTokenAge: "5 minutes",
        clockTolerance: 5,
      },
    ));
  } catch (error) {
    if (error instanceof errors.JWTExpired) return { ok: false, reason: "expired" };
    if (error instanceof errors.JWTClaimValidationFailed) {
      return {
        ok: false,
        reason: error.claim === "aud" ? "wrong_audience" : "missing_claims",
      };
    }
    if (error instanceof errors.JWSSignatureVerificationFailed) {
      return { ok: false, reason: "bad_signature" };
    }
    return { ok: false, reason: "malformed" };
  }

  const shopDomain = String(payload.shop ?? "").trim().toLowerCase();
  const email = String(payload.email ?? "").trim().toLowerCase();
  const jti = typeof payload.jti === "string" ? payload.jti : "";

  // Rule: the shop key is the *.myshopify.com domain, lowercase (§3). An app
  // that sends an internal UUID here is not giving Growzar a shop, and Growzar
  // never maps UUIDs.
  if (!shopDomain.endsWith(".myshopify.com") || !email || !jti) {
    return { ok: false, reason: "missing_claims" };
  }
  if (!payload.exp) return { ok: false, reason: "missing_claims" };

  return {
    ok: true,
    claims: {
      app,
      shopDomain,
      email,
      shopifyUserId:
        typeof payload.shopifyUserId === "string" ? payload.shopifyUserId : null,
      isStoreOwner: payload.isStoreOwner === true,
      locale: typeof payload.locale === "string" ? payload.locale : null,
      jti,
      expiresAt: new Date(payload.exp * 1000),
    },
  };
}

/**
 * How long a verified claim waits for the person to finish signing up. Long
 * enough for a real sign-up, short enough that an abandoned one is not a
 * standing grant over someone's shop.
 */
export const PENDING_CLAIM_TTL_MS = 30 * 60 * 1000;

/**
 * Verify, mark the `jti` used, and hand back a pending claim.
 *
 * The unique constraint on `jti` is what enforces single use, not a prior
 * read: two replays arriving at the same instant both pass a "have I seen
 * this?" check, and only one survives the insert. A duplicate key here is a
 * replay, and it is reported as one.
 */
export async function consumeClaimToken(
  token: string,
): Promise<
  | { ok: true; claims: ClaimTokenClaims; pendingClaimId: string }
  | { ok: false; reason: ClaimFailure }
> {
  const verified = await verifyClaimToken(token);
  if (!verified.ok) return verified;

  const { claims } = verified;

  try {
    const pendingClaim = await prisma.$transaction(async (tx) => {
      await tx.consumedClaimToken.create({
        data: {
          jti: claims.jti,
          app: claims.app,
          shopDomain: claims.shopDomain,
          email: claims.email,
          tokenExpiresAt: claims.expiresAt,
        },
      });

      return tx.pendingClaim.create({
        data: {
          app: claims.app,
          shopDomain: claims.shopDomain,
          email: claims.email,
          shopifyUserId: claims.shopifyUserId,
          isStoreOwner: claims.isStoreOwner,
          locale: claims.locale,
          expiresAt: new Date(Date.now() + PENDING_CLAIM_TTL_MS),
        },
      });
    });

    return { ok: true, claims, pendingClaimId: pendingClaim.id };
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "P2002"
    ) {
      return { ok: false, reason: "already_used" };
    }
    throw error;
  }
}

export const CLAIM_FAILURE_MESSAGES: Record<ClaimFailure, string> = {
  malformed: "That link is not a valid Growzar link.",
  unknown_issuer: "That link came from an app Growzar does not recognise.",
  app_not_configured:
    "Growzar is not configured to talk to that app yet. Tell us and we will fix it.",
  bad_signature: "That link could not be verified.",
  expired: "That link has expired. Press “Open in Growzar” again.",
  wrong_audience: "That link was not issued for Growzar.",
  missing_claims: "That link is missing information Growzar needs.",
  already_used:
    "That link has already been used. Press “Open in Growzar” again for a fresh one.",
};
