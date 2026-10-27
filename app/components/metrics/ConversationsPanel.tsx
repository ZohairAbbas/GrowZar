import { MoneyList, Stat } from "./Metrics";

/**
 * The Inbox section (G-GZR5-13): WhatKaBot's conversations as metadata only
 * (D-55). Computed on the server in `metrics/conversations.ts`.
 */

type Money = { amount: string; currency: string };
export type ConversationsPanelView = {
  opened: number;
  byChannel: Array<{ channel: string; conversations: number }>;
  aiOnly: number;
  withAgent: number;
  unanswered: number;
  escalated: number;
  medianFirstResponseMinutes: number | null;
  csat: { average: number | null; rated: number };
  aiCost: Money[];
  categories: Array<{ category: string; conversations: number; share: number; topSubcategory: string | null; escalated: number; medianFirstResponseMinutes: number | null; withOrder: number }>;
  now: { open: number; waiting: number; quiet: number; pendingAgent: number; overdue: number };
  waitingList: Array<{ id: string; channel: string; phoneTail: string | null; category: string | null; subcategory: string | null; status: string; owner: "ai" | "agent" | null; waitingMinutes: number; overdue: boolean; orders: number }>;
  messages: { inbound: number; outboundByAuthor: Array<{ author: string; messages: number }>; failed: number; failedByCode: Array<{ code: string; messages: number }> };
};

const n = (x: number) => x.toLocaleString("en-GB");
const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : "—");
const words = (s: string | null) => (s ? s.replace(/_/g, " ") : "—");
const CHANNEL: Record<string, string> = { whatsapp: "WhatsApp", email: "Email", instagram: "Instagram", messenger: "Messenger", livechat: "Live chat" };
const AUTHOR: Record<string, string> = { ai: "AI", agent: "Your team", campaign: "Campaigns", playbook: "Playbooks", notification: "Order notifications", system: "Automated (incl. Courierify)" };
function duration(min: number | null) {
  if (min === null) return "—";
  if (min < 60) return `${Math.round(min)} min`;
  if (min < 48 * 60) return `${(min / 60).toFixed(1)} h`;
  return `${Math.round(min / 1440)} days`;
}

export function ConversationsPanel({ view, periodDays, whatkabotUrl }: { view: ConversationsPanelView; periodDays: number; whatkabotUrl: string }) {
  const answered = view.aiOnly + view.withAgent;
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-white p-5">
        <p className="max-w-2xl text-sm text-gray-600">
          From WhatKaBot. Growzar shows what conversations are about, who answered and how fast; it never receives message text. Read and
          reply in WhatKaBot.
        </p>
        <a href={whatkabotUrl} target="_blank" rel="noopener" className="rounded-full bg-navy px-4 py-2.5 text-sm font-semibold text-white hover:bg-navy-surface">
          Open WhatKaBot
        </a>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Waiting on you now"
          note={`Buyer wrote last, in the past 7 days. ${n(view.now.quiet)} more went quiet before that; ${n(view.now.pendingAgent)} handed to your team`}
        >
          {n(view.now.waiting)}
        </Stat>
        <Stat label="Past their reply deadline" note="Open, with WhatKaBot's response deadline passed">
          {n(view.now.overdue)}
        </Stat>
        <Stat label={`Conversations, ${periodDays} days`} note={view.byChannel.map((c) => `${CHANNEL[c.channel] ?? c.channel} ${n(c.conversations)}`).join(" · ") || "None"}>
          {n(view.opened)}
        </Stat>
        <Stat label="First reply, median" note={`${pct(view.aiOnly, answered)} answered by AI alone; ${n(view.unanswered)} never answered`}>
          {duration(view.medianFirstResponseMinutes)}
        </Stat>
      </div>

      <div className="rounded-2xl bg-white p-5">
        <h2 className="font-display text-lg font-bold text-gray-900">What buyers write in about</h2>
        <p className="mt-1 text-sm text-gray-600">WhatKaBot's own categories for the conversations opened in this period.</p>
        <div className="mt-4 overflow-x-auto">
          <table className="pin-first min-w-full text-sm">
            <thead className="border-b border-gray-100 text-left text-xs font-semibold text-gray-500">
              <tr>
                <th className="py-2 pr-4">Category</th>
                <th className="py-2 pr-4 text-right">Conversations</th>
                <th className="py-2 pr-4 text-right">Share</th>
                <th className="py-2 pr-4">Most common</th>
                <th className="py-2 pr-4 text-right">First reply</th>
                <th className="py-2 pr-4 text-right">Escalated</th>
                <th className="py-2 text-right">About an order</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {view.categories.map((c) => (
                <tr key={c.category}>
                  <td className="py-2 pr-4 font-medium capitalize text-gray-900">{words(c.category)}</td>
                  <td className="py-2 pr-4 text-right tabular-nums text-gray-900">{n(c.conversations)}</td>
                  <td className="py-2 pr-4 text-right tabular-nums text-gray-700">{c.share.toFixed(1)}%</td>
                  <td className="py-2 pr-4 text-gray-700">{words(c.topSubcategory)}</td>
                  <td className="py-2 pr-4 text-right tabular-nums text-gray-700">{duration(c.medianFirstResponseMinutes)}</td>
                  <td className="py-2 pr-4 text-right tabular-nums text-gray-700">{n(c.escalated)}</td>
                  <td className="py-2 text-right tabular-nums text-gray-700">{n(c.withOrder)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-2xl bg-white p-5">
        <h2 className="font-display text-lg font-bold text-gray-900">Waiting longest</h2>
        <p className="mt-1 text-sm text-gray-600">Open conversations where the buyer wrote last, in the past 7 days.</p>
        {view.waitingList.length ? (
          <div className="mt-4 overflow-x-auto">
            <table className="pin-first min-w-full text-sm">
              <thead className="border-b border-gray-100 text-left text-xs font-semibold text-gray-500">
                <tr>
                  <th className="py-2 pr-4">Buyer</th>
                  <th className="py-2 pr-4">Channel</th>
                  <th className="py-2 pr-4">About</th>
                  <th className="py-2 pr-4">With</th>
                  <th className="py-2 pr-4 text-right">Waiting</th>
                  <th className="py-2 text-right">Orders</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {view.waitingList.map((c) => (
                  <tr key={c.id}>
                    <td className="py-2 pr-4 tabular-nums text-gray-900">{c.phoneTail ? `···${c.phoneTail}` : "No phone"}</td>
                    <td className="py-2 pr-4 text-gray-700">{CHANNEL[c.channel] ?? c.channel}</td>
                    <td className="py-2 pr-4 capitalize text-gray-700">{words(c.subcategory ?? c.category)}</td>
                    <td className="py-2 pr-4 text-gray-700">{c.owner === "agent" ? "Your team" : c.owner === "ai" ? "AI" : "Unassigned"}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">
                      <span className={c.overdue ? "font-semibold text-red-700" : "text-gray-900"}>{duration(c.waitingMinutes)}</span>
                    </td>
                    <td className="py-2 text-right tabular-nums text-gray-700">{c.orders || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="mt-3 text-sm text-gray-700">No buyer is waiting for a reply.</p>
        )}
      </div>

      <div className="rounded-2xl bg-white p-5">
        <h2 className="font-display text-lg font-bold text-gray-900">Messages sent</h2>
        <p className="mt-1 text-sm text-gray-600">
          {n(view.messages.inbound)} received in this period.
          {view.messages.failed ? ` ${n(view.messages.failed)} of the store's messages failed to deliver.` : ""}
          {view.csat.rated ? ` Satisfaction ${view.csat.average?.toFixed(1)} of 5 from ${n(view.csat.rated)} ratings.` : ""}
          {view.aiCost.length ? <> AI cost <MoneyList values={view.aiCost} />.</> : null}
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          {view.messages.outboundByAuthor.map((a) => (
            <span key={a.author} className="rounded-full bg-field px-3 py-1.5 text-sm">
              <span className="font-semibold text-gray-900">{AUTHOR[a.author] ?? a.author}</span> <span className="tabular-nums text-gray-700">{n(a.messages)}</span>
            </span>
          ))}
        </div>
        {view.messages.failedByCode.length ? (
          <p className="mt-3 text-xs text-gray-500">Most common failures: {view.messages.failedByCode.map((f) => `${f.code.replace(/_/g, " ")} (${n(f.messages)})`).join(", ")}.</p>
        ) : null}
        <p className="mt-3 text-xs text-gray-500">Delivery and read times are when WhatKaBot heard about them, and start on 10 October 2026.</p>
      </div>
    </section>
  );
}
