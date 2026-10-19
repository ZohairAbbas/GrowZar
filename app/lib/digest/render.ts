/**
 * The weekly digest as an email (G-GZR6-5): HTML and plain text from what
 * the builder chose. Pure, so the preview page shows exactly the bytes the
 * worker sends. Every string that came from a store (product, campaign and
 * store names) is escaped here and nowhere else.
 */

export type DigestLink = { href: string; label: string };

export type DigestRow = {
  headline: string;
  figure: string;
  /** Home's second line: the next step, else why it matters, else the note. */
  line: string;
  link: DigestLink;
  /** The button into the app that fixes it, or its install. */
  action: DigestLink | null;
};

export type DigestAppLead = { appName: string; headline: string; body: string; link: DigestLink };

/** One outcome measured this week (G-GZR9-5): the same sentence as the card and Results. */
export type DigestResult = { text: string; link: DigestLink };

export type DigestStoreBlock = { name: string; rows: DigestRow[]; app: DigestAppLead | null; results?: DigestResult[] };

export type DigestEmail = {
  recipientName: string | null;
  organizationName: string;
  /** e.g. "Monday 19 October" */
  weekLabel: string;
  stores: DigestStoreBlock[];
  homeUrl: string;
  settingsUrl: string;
  unsubscribeUrl: string;
  test?: boolean;
};

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const plural = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;

export function digestSubject(d: Pick<DigestEmail, "stores" | "test">): string {
  const rows = d.stores.reduce((t, s) => t + s.rows.length, 0);
  const where = d.stores.length === 1 ? ` at ${d.stores[0]!.name}` : "";
  const what = rows ? `${plural(rows, "thing needs", "things need")} your attention${where}` : `Your week${where}`;
  return `${d.test ? "[Test] " : ""}${what}`;
}

const button = (l: DigestLink) =>
  `<a href="${esc(l.href)}" style="display:inline-block;padding:8px 16px;background:#0f172a;color:#ffffff;text-decoration:none;border-radius:999px;font-weight:600;font-size:14px;">${esc(l.label)} &rarr;</a>`;

const textLink = (l: DigestLink) =>
  `<a href="${esc(l.href)}" style="color:#2563eb;text-decoration:none;font-weight:600;font-size:14px;">${esc(l.label)} &#8599;</a>`;

function rowHtml(r: DigestRow): string {
  return `
          <tr><td style="padding:16px 0;border-top:1px solid #f1f5f9;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
              <td style="vertical-align:top;">
                <p style="margin:0;font-size:15px;font-weight:600;color:#111827;line-height:1.4;">${esc(r.headline)}</p>
                <p style="margin:4px 0 0;font-size:14px;color:#6b7280;line-height:1.5;">${esc(r.line)}</p>
              </td>
              <td style="vertical-align:top;text-align:right;padding-left:16px;white-space:nowrap;font-size:20px;font-weight:700;color:#111827;">${esc(r.figure)}</td>
            </tr></table>
            <p style="margin:12px 0 0;">${button(r.link)}${r.action ? `&nbsp;&nbsp;&nbsp;${textLink(r.action)}` : ""}</p>
          </td></tr>`;
}

function appHtml(a: DigestAppLead): string {
  return `
          <tr><td style="padding:16px;background:#f0fdf9;border-radius:12px;">
            <p style="margin:0;font-size:12px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:#047857;">Next app for your store · ${esc(a.appName)}</p>
            <p style="margin:6px 0 0;font-size:15px;font-weight:600;color:#111827;line-height:1.4;">${esc(a.headline)}</p>
            <p style="margin:4px 0 12px;font-size:14px;color:#4b5563;line-height:1.5;">${esc(a.body)}</p>
            ${button(a.link)}
          </td></tr>`;
}

function resultHtml(r: DigestResult): string {
  return `
          <tr><td style="padding:12px 0;border-top:1px solid #f1f5f9;">
            <p style="margin:0;font-size:14px;color:#374151;line-height:1.5;">${esc(r.text)}</p>
            <p style="margin:8px 0 0;">${textLink(r.link)}</p>
          </td></tr>`;
}

function storeHtml(s: DigestStoreBlock, multi: boolean): string {
  return `
      <tr><td style="padding:24px 32px 8px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          ${multi ? `<tr><td style="padding:0 0 4px;font-size:13px;font-weight:700;color:#6b7280;">${esc(s.name)}</td></tr>` : ""}
          ${s.rows.length ? `<tr><td style="padding:0 0 4px;font-size:18px;font-weight:700;color:#111827;">Needs your attention</td></tr>${s.rows.map(rowHtml).join("")}` : ""}
          ${s.app ? `<tr><td style="height:${s.rows.length ? 16 : 0}px;"></td></tr>${appHtml(s.app)}` : ""}
          ${s.results?.length ? `<tr><td style="padding:20px 0 4px;font-size:18px;font-weight:700;color:#111827;">Measured this week</td></tr>${s.results.map(resultHtml).join("")}` : ""}
        </table>
      </td></tr>`;
}

export function renderDigest(d: DigestEmail): { subject: string; html: string; text: string } {
  const multi = d.stores.length > 1;
  const hello = d.recipientName ? `Hi ${esc(d.recipientName)},` : "Hi,";
  const html = `<!doctype html>
<html><body style="margin:0;background:#f5f5f5;font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:16px;overflow:hidden;">
        <tr><td style="padding:24px 32px;background:#0f172a;color:#ffffff;">
          <span style="font-size:18px;font-weight:600;">Growzar</span>
          <span style="float:right;font-size:13px;color:#94a3b8;line-height:27px;">Week of ${esc(d.weekLabel)}</span>
        </td></tr>
        ${d.test ? `<tr><td style="padding:12px 32px;background:#fef3c7;color:#92400e;font-size:13px;">A test send from the digest preview. Nothing here was counted.</td></tr>` : ""}
        <tr><td style="padding:28px 32px 0;font-size:15px;color:#374151;line-height:1.6;">${hello} here is what Growzar found this week${multi ? ` across ${esc(d.organizationName)}'s stores` : ""}.</td></tr>
        ${d.stores.map((s) => storeHtml(s, multi)).join("")}
        <tr><td style="padding:16px 32px 28px;">
          <a href="${esc(d.homeUrl)}" style="color:#2563eb;text-decoration:none;font-weight:600;font-size:14px;">Open Growzar &rarr;</a>
        </td></tr>
        <tr><td style="padding:20px 32px;background:#f8fafc;font-size:12px;color:#6b7280;line-height:1.6;">
          Findings are from each store's last 30 days and the next app from its last 90, as on Home. Amounts are what happened, not what an app would save.<br>
          You get this because you are a member of ${esc(d.organizationName)} on Growzar.
          <a href="${esc(d.unsubscribeUrl)}" style="color:#6b7280;">Unsubscribe</a> ·
          <a href="${esc(d.settingsUrl)}" style="color:#6b7280;">Email settings</a>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const lines: string[] = [];
  if (d.test) lines.push("[A test send from the digest preview. Nothing here was counted.]", "");
  lines.push(`${d.recipientName ? `Hi ${d.recipientName},` : "Hi,"} here is what Growzar found this week (week of ${d.weekLabel}).`, "");
  for (const s of d.stores) {
    if (multi) lines.push(`== ${s.name} ==`, "");
    if (s.rows.length) {
      lines.push("Needs your attention", "");
      for (const r of s.rows) {
        lines.push(`* ${r.headline}: ${r.figure}`, `  ${r.line}`, `  ${r.link.label}: ${r.link.href}`);
        if (r.action) lines.push(`  ${r.action.label}: ${r.action.href}`);
        lines.push("");
      }
    }
    if (s.app) lines.push(`Next app for your store: ${s.app.appName}`, s.app.headline, s.app.body, `${s.app.link.label}: ${s.app.link.href}`, "");
    if (s.results?.length) {
      lines.push("Measured this week", "");
      for (const r of s.results) lines.push(`* ${r.text}`, `  ${r.link.label}: ${r.link.href}`, "");
    }
  }
  lines.push(
    `Open Growzar: ${d.homeUrl}`,
    "",
    "Findings are from each store's last 30 days and the next app from its last 90, as on Home. Amounts are what happened, not what an app would save.",
    `You get this because you are a member of ${d.organizationName} on Growzar.`,
    `Unsubscribe: ${d.unsubscribeUrl}`,
    `Email settings: ${d.settingsUrl}`,
  );
  return { subject: digestSubject(d), html, text: lines.join("\n") };
}
