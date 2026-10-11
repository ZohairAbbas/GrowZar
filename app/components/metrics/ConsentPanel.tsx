
/** Who may be messaged, from Retainify's consent (G-GZR5-7, rule #22). Computed in `metrics/consent.ts`. */

type Channel = "email" | "whatsapp" | "push";
export type ConsentPanelView = {
  contacts: number;
  matchedBuyers: number;
  buyers: number;
  reachableBuyers: Record<Channel | "any", number>;
  reachableContacts: Record<Channel, number>;
  whatkabot: { numbers: number; marketingIn: number; marketingOut: number; marketingUnknown: number; utilityIn: number } | null;
  changes: Array<{ channel: Channel; optedIn: number; optedOut: number; reasons: Array<{ reason: string; count: number }> }>;
};

export const CHANNEL_NAME: Record<Channel, string> = { email: "Email", whatsapp: "WhatsApp", push: "Push" };
const n = (x: number) => x.toLocaleString("en-GB");
const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : "—");
function Figure({ label, value, note }: { label: string; value: number; note: string }) {
  return (
    <div className="rounded-xl bg-field p-3">
      <p className="text-xs font-semibold text-gray-500">{label}</p>
      <p className="mt-1 font-display text-xl font-bold tabular-nums text-gray-900">{n(value)}</p>
      <p className="text-xs text-gray-600">{note}</p>
    </div>
  );
}

const REASON: Record<string, string> = { unsubscribe: "unsubscribed", bounce: "bounced", complaint: "marked as spam", blocked: "blocked", invalid: "invalid number", gdpr: "erased on request" };

export function ConsentPanel({ view, periodDays }: { view: ConsentPanelView; periodDays: number }) {
  const changed = view.changes.filter((c) => c.optedIn || c.optedOut);
  return (
    <div className="rounded-2xl bg-white p-5">
      <h2 className="font-display text-lg font-bold text-gray-900">Who you can message</h2>
      <p className="mt-1 text-sm text-gray-600">
        From Retainify's consent{view.whatkabot ? " and WhatKaBot's WhatsApp consent" : ""}. {n(view.matchedBuyers)} of your {n(view.buyers)} buyers matched a contact by phone (
        {pct(view.matchedBuyers, view.buyers)}).
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Figure label="May be messaged at all" value={view.reachableBuyers.any} note={`Of ${n(view.matchedBuyers)} matched buyers`} />
        {(["email", "whatsapp", "push"] as const).map((c) => (
          <Figure key={c} label={CHANNEL_NAME[c]} value={view.reachableBuyers[c]} note={`${n(view.reachableContacts[c])} of ${n(view.contacts)} contacts`} />
        ))}
      </div>
      {view.whatkabot ? (
        <p className="mt-4 text-sm text-gray-700">
          WhatKaBot holds WhatsApp consent for {n(view.whatkabot.numbers)} numbers: {n(view.whatkabot.marketingIn)} agreed to marketing,{" "}
          {n(view.whatkabot.marketingOut)} opted out and {n(view.whatkabot.marketingUnknown)} were never asked; {n(view.whatkabot.utilityIn)} accept order
          updates, which are not marketing. A WhatKaBot opt-out wins over Retainify on WhatsApp.
        </p>
      ) : null}
      <p className="mt-4 text-sm text-gray-700">
        {changed.length
          ? changed
              .map(
                (c) =>
                  `${CHANNEL_NAME[c.channel]}: ${n(c.optedIn)} opted in, ${n(c.optedOut)} left` +
                  (c.reasons.length ? ` (${c.reasons.map((r) => `${n(r.count)} ${REASON[r.reason] ?? r.reason}`).join(", ")})` : ""),
              )
              .join(". ") + "."
          : `No one opted in or out in the last ${periodDays} days.`}
      </p>
      <ul className="mt-3 list-disc space-y-0.5 pl-5 text-xs text-gray-500">
        <li>May be messaged: Retainify says subscribed on that channel and the buyer is not suppressed (unsubscribed, bounced, blocked).</li>
        <li>History of changes starts on 8 October 2026 (Retainify) and 10 October 2026 (WhatKaBot); earlier changes are not known.</li>
      </ul>
    </div>
  );
}
