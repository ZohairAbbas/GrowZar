import { canSendEmail, env } from "./env.server";

/**
 * Outbound email through Resend's HTTP API.
 *
 * Deliberately a `fetch` call rather than the SDK: the only two messages
 * Growzar sends in Phase 1 are a magic link and an invitation, and a
 * dependency that ships its own retry policy would fight the one the connector
 * framework installs in G-GZR-4.
 *
 * Until RESEND_API_KEY is filled in, every send is logged instead, including
 * the link itself. That keeps sign-in and invitations demonstrable on a box
 * with no key, and it is loud enough that nobody mistakes it for a real send.
 */
type Message = {
  to: string;
  subject: string;
  html: string;
  text: string;
};

export type SendResult =
  | { sent: true; id: string }
  | { sent: false; reason: "no_api_key" | "send_failed"; detail?: string };

export async function sendEmail(message: Message): Promise<SendResult> {
  if (!canSendEmail) {
    console.warn(
      `[email] RESEND_API_KEY is empty — not sending. to=${message.to} subject=${JSON.stringify(
        message.subject,
      )}\n${message.text}`,
    );
    return { sent: false, reason: "no_api_key" };
  }

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: env.RESEND_FROM_EMAIL,
        to: [message.to],
        subject: message.subject,
        html: message.html,
        text: message.text,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      // The body can quote the recipient address; the status and Resend's
      // error code are what we need, so log those and keep the rest out.
      console.error(
        `[email] Resend rejected the message: ${response.status} ${detail.slice(0, 200)}`,
      );
      return { sent: false, reason: "send_failed", detail: String(response.status) };
    }

    const body = (await response.json()) as { id?: string };
    return { sent: true, id: body.id ?? "unknown" };
  } catch (error) {
    console.error("[email] send failed", error);
    return {
      sent: false,
      reason: "send_failed",
      detail: error instanceof Error ? error.message : "unknown",
    };
  }
}

const shell = (heading: string, body: string, cta: { url: string; label: string }) => `
<!doctype html>
<html><body style="margin:0;background:#f5f5f5;font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:16px;overflow:hidden;">
        <tr><td style="padding:28px 32px;background:#0f172a;color:#ffffff;font-size:18px;font-weight:600;">Growzar</td></tr>
        <tr><td style="padding:32px;">
          <h1 style="margin:0 0 12px;font-size:20px;color:#111827;">${heading}</h1>
          <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#4b5563;">${body}</p>
          <a href="${cta.url}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#ffffff;text-decoration:none;border-radius:10px;font-weight:600;font-size:15px;">${cta.label}</a>
          <p style="margin:24px 0 0;font-size:13px;line-height:1.6;color:#6b7280;">If the button does not work, paste this link into your browser:<br><span style="color:#2563eb;word-break:break-all;">${cta.url}</span></p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

export function sendMagicLinkEmail(to: string, url: string) {
  return sendEmail({
    to,
    subject: "Your Growzar sign-in link",
    html: shell(
      "Sign in to Growzar",
      "This link signs you in and expires shortly. If you did not ask for it, you can ignore this email.",
      { url, label: "Sign in" },
    ),
    text: `Sign in to Growzar:\n\n${url}\n\nThis link expires shortly. If you did not ask for it, ignore this email.`,
  });
}

export function sendInvitationEmail(options: {
  to: string;
  organizationName: string;
  inviterName: string;
  role: string;
  url: string;
}) {
  const { to, organizationName, inviterName, role, url } = options;
  return sendEmail({
    to,
    subject: `${inviterName} invited you to ${organizationName} on Growzar`,
    html: shell(
      `Join ${organizationName}`,
      `${inviterName} invited you to join <strong>${organizationName}</strong> on Growzar as <strong>${role}</strong>.`,
      { url, label: "Accept invitation" },
    ),
    text: `${inviterName} invited you to join ${organizationName} on Growzar as ${role}.\n\nAccept the invitation:\n${url}`,
  });
}
