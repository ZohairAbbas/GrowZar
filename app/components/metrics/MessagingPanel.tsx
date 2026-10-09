import { MoneyList } from "./Metrics";

/**
 * Retainify's messages in the Marketing section (G-GZR5-5). Plain types only:
 * the view is computed on the server in `metrics/messaging.ts`.
 */

type Money = { amount: string; currency: string };
type Counts = { sent: number; reached: number; opened: number; clicked: number; failed: number; noDeliveryReport: number };
type Followed = { orders: number; delivered: number; returned: number; open: number; deliveredRevenue: Money[] };

export type MessagingPanelView = {
  messages: number;
  matched: number;
  channels: Array<{ channel: "email" | "whatsapp" | "push" } & Counts>;
  journeys: Array<{ journeyId: string | null; name: string; kind: "flow" | "campaign" | null } & Counts & Followed>;
  followed: Followed & { viaClick: number; viaReach: number; sameSession: number };
};

const CHANNEL: Record<string, string> = { email: "Email", whatsapp: "WhatsApp", push: "Push" };
const n = (x: number) => x.toLocaleString("en-GB");
const share = (part: number, whole: number) => (whole ? `${((100 * part) / whole).toFixed(1)}%` : "—");

export function MessagingPanel({ view, periodDays }: { view: MessagingPanelView; periodDays: number }) {
  const f = view.followed;
  const unreported = view.channels.reduce((s, c) => s + c.noDeliveryReport, 0);
  return (
    <div className="rounded-2xl bg-white p-5">
      <h2 className="font-display text-lg font-bold text-gray-900">Messages from Retainify</h2>
      <p className="mt-1 text-sm text-gray-600">
        {n(view.messages)} sent in the last {periodDays} days. {share(view.matched, view.messages)} went to a buyer Growzar could match to
        one of your customers by phone.
      </p>

      <div className="mt-4 flex flex-wrap gap-2">
        {view.channels.map((c) => (
          <span key={c.channel} className="rounded-full bg-field px-3 py-1.5 text-sm">
            <span className="font-semibold text-gray-900">{CHANNEL[c.channel]}</span>{" "}
            <span className="tabular-nums text-gray-700">
              {n(c.sent)} sent · {share(c.opened, c.reached)} opened · {n(c.clicked)} clicked
              {c.failed ? ` · ${n(c.failed)} failed` : ""}
            </span>
          </span>
        ))}
      </div>

      <p className="mt-4 text-sm text-gray-700">
        <strong className="text-gray-900">{n(f.orders)}</strong> {f.orders === 1 ? "order" : "orders"} followed a message
        {f.orders ? (
          <>
            : {n(f.delivered)} delivered, {n(f.returned)} returned, {n(f.open)} still open. Delivered revenue{" "}
            <strong className="text-gray-900">{f.deliveredRevenue.length ? <MoneyList values={f.deliveredRevenue} /> : "none yet"}</strong>.
          </>
        ) : (
          "."
        )}
      </p>

      <div className="mt-4 overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="border-b border-gray-100 text-left text-xs font-semibold text-gray-500">
            <tr>
              <th className="py-2 pr-4">Journey</th>
              <th className="py-2 pr-4">Kind</th>
              <th className="py-2 pr-4 text-right">Sent</th>
              <th className="py-2 pr-4 text-right">Opened</th>
              <th className="py-2 pr-4 text-right">Clicked</th>
              <th className="py-2 pr-4 text-right">Orders after</th>
              <th className="py-2 pr-4 text-right">Delivered</th>
              <th className="py-2 pr-4 text-right">Returned</th>
              <th className="py-2 text-right">Delivered revenue</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {view.journeys.slice(0, 15).map((j) => (
              <tr key={j.journeyId ?? "none"}>
                <td className="max-w-xs truncate py-2 pr-4 font-medium text-gray-900" title={j.name}>{j.name}</td>
                <td className="py-2 pr-4 text-gray-600">{j.kind === "campaign" ? "Campaign" : j.kind === "flow" ? "Flow" : "—"}</td>
                <td className="py-2 pr-4 text-right tabular-nums text-gray-900">{n(j.sent)}</td>
                <td className="py-2 pr-4 text-right tabular-nums text-gray-700">{share(j.opened, j.reached)}</td>
                <td className="py-2 pr-4 text-right tabular-nums text-gray-700">{n(j.clicked)}</td>
                <td className="py-2 pr-4 text-right tabular-nums text-gray-900">{n(j.orders)}</td>
                <td className="py-2 pr-4 text-right tabular-nums text-gray-700">{n(j.delivered)}</td>
                <td className="py-2 pr-4 text-right tabular-nums text-gray-700">{n(j.returned)}</td>
                <td className="py-2 text-right tabular-nums text-gray-900">
                  {j.deliveredRevenue.length ? <MoneyList values={j.deliveredRevenue} /> : <span className="text-gray-400">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="mt-3 list-disc space-y-0.5 pl-5 text-xs text-gray-500">
        <li>
          An order follows a message when the same buyer orders within 7 days of clicking it, or otherwise within 1 day of receiving it; each
          order counts once, for the latest such message ({n(f.viaClick)} by a click, {n(f.viaReach)} by receiving). Counted by Growzar from
          your orders, not Retainify's own revenue figure.
        </li>
        {f.sameSession ? (
          <li>
            {n(f.sameSession)} more {f.sameSession === 1 ? "order was" : "orders were"} placed within an hour of the same buyer's previous order: the
            same shopping session, so not credited to a message.
          </li>
        ) : null}
        <li>Buyers are matched by phone. Messages to a buyer Growzar only knows by email cannot be matched yet.</li>
        {unreported ? <li>{n(unreported)} messages have no delivery report from the provider and are timed from when they were sent.</li> : null}
      </ul>
    </div>
  );
}
