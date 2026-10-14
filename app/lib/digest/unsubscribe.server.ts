import { createHmac, timingSafeEqual } from "node:crypto";

import { env } from "../env.server";

/**
 * The digest's unsubscribe link (G-GZR6-5): names one membership and is
 * signed, so it works without signing in and cannot be made for anyone
 * else. It does not expire: an unsubscribe link from an old email must still
 * work. Opening it changes nothing; only the confirm button, or a mail
 * client's one-click POST (RFC 8058), does. Link scanners such as Microsoft
 * 365 Safe Links open every link in an email, which is how they use up
 * magic links, and must not unsubscribe anyone.
 */

const mac = (memberId: string) =>
  createHmac("sha256", env.BETTER_AUTH_SECRET).update(`digest-unsubscribe:${memberId}`).digest("base64url");

export function unsubscribeToken(memberId: string): string {
  return `${Buffer.from(memberId).toString("base64url")}.${mac(memberId)}`;
}

/** The member a token names, or null if it was not made here. */
export function readUnsubscribeToken(token: string | null | undefined): string | null {
  if (!token) return null;
  const [id, sig] = token.split(".");
  if (!id || !sig) return null;
  const memberId = Buffer.from(id, "base64url").toString();
  const expected = Buffer.from(mac(memberId));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given) ? memberId : null;
}

export const unsubscribeUrl = (memberId: string) => `${env.BETTER_AUTH_URL}/digest/unsubscribe?t=${unsubscribeToken(memberId)}`;
