import { z } from "zod";

/**
 * Server environment, read once at boot.
 *
 * Anything missing here fails the process at start rather than at the first
 * request, because a half-configured Growzar is worse than a dead one: a
 * missing signing secret would mean unsigned outbound calls, and a missing
 * BETTER_AUTH_SECRET would mean sessions that silently stop verifying after a
 * restart.
 *
 * Optional-but-empty is a real state on this box today (the platform keys are
 * minted out of band, the Resend key arrives separately), so those are
 * `optional()` here and the code that needs them says so at the point of use.
 */
const schema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  BETTER_AUTH_SECRET: z
    .string()
    .min(32, "BETTER_AUTH_SECRET must be at least 32 characters"),
  BETTER_AUTH_URL: z.string().url(),

  // Outbound email. Empty until the key is filled in; the mailer logs instead
  // of sending while it is, so magic links still work in development.
  RESEND_API_KEY: z.string().optional(),
  RESEND_FROM_EMAIL: z
    .string()
    .default("Growzar <no-reply@growzar.com>"),

  ENCRYPTION_KEY: z
    .string()
    .min(32, "ENCRYPTION_KEY must be 32 bytes, base64"),
});

function read() {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Environment is not usable:\n${problems}`);
  }
  return parsed.data;
}

export const env = read();

/** True once a real Resend key is present. */
export const canSendEmail = Boolean(env.RESEND_API_KEY);
