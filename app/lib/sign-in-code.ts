/**
 * The 6-digit sign-in code (pre-Wave-1 pack 3), typed where the magic link
 * can't reach: an iPhone home-screen app, whose cookies are its own.
 */

/** What the merchant typed, as the six digits Better Auth checks, or null. Spaces and dashes are allowed. */
export function readCode(input: string): string | null {
  const digits = input.replace(/[\s-]/g, "");
  return /^\d{6}$/.test(digits) ? digits : null;
}

/** Better Auth's email-OTP errors, in Growzar's words. */
export function codeFailure(message: string | null): string {
  switch (message) {
    case "OTP expired":
      return "That code has expired. Ask for a new email.";
    case "Too many attempts":
      return "Too many wrong tries for that code. Ask for a new email.";
    default:
      return "That code didn't match. Check the newest email from Growzar and try again.";
  }
}
