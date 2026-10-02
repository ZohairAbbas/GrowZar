import { useState, type ReactNode } from "react";
import { Link, useFetcher } from "react-router";
import { ArrowRight } from "lucide-react";

import type {
  CashHeldFinding,
  UnconfirmedFinding,
  CourierifyStoppedFinding,
  DecidedBy,
  DisagreementFinding,
  Finding,
  MarginFinding,
  MissingFeesFinding,
  VariantReturnsFinding,
  VariantRate,
} from "~/lib/metrics/findings";
import type { InboxView } from "~/lib/insights/inbox.server";
import { DISMISS_REASONS } from "~/lib/insights/actions";
import { formatAmount, MoneyList, outcomeLabel } from "./Metrics";

/** Through the click-through route, which records the click (G-GZR3-3). */
const via = (id: string, to: string) => `/insights/${id}/open?to=${encodeURIComponent(to)}`;

const REASONS = Object.entries(DISMISS_REASONS);

function InsightActions({ id }: { id: string }) {
  const fetcher = useFetcher();
  const [dismissing, setDismissing] = useState(false);
  const busy = fetcher.state !== "idle";
  const button = "rounded-md border border-gray-200 px-2.5 py-1 text-xs text-gray-600 hover:border-gray-300 hover:text-gray-900 disabled:opacity-50";
  return (
    <div className="mt-4 border-t border-gray-100 pt-3">
      {dismissing ? (
        <fetcher.Form method="post" action={`/insights/${id}`} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="intent" value="dismiss" />
          <label className="text-xs text-gray-600" htmlFor={`reason-${id}`}>
            Why?
          </label>
          <select id={`reason-${id}`} name="reason" required defaultValue="" className="rounded-md border border-gray-200 px-2 py-1 text-xs">
            <option value="" disabled>
              Choose a reason
            </option>
            {REASONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <input name="note" maxLength={500} placeholder="Note (optional)" className="min-w-0 flex-1 rounded-md border border-gray-200 px-2 py-1 text-xs" />
          <button type="submit" disabled={busy} className={button}>
            Dismiss
          </button>
          <button type="button" onClick={() => setDismissing(false)} className="text-xs text-gray-500 hover:underline">
            Cancel
          </button>
        </fetcher.Form>
      ) : (
        <fetcher.Form method="post" action={`/insights/${id}`} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="intent" value="snooze" />
          <button type="button" disabled={busy} onClick={() => setDismissing(true)} className={button}>
            Dismiss…
          </button>
          <button type="submit" name="days" value="7" disabled={busy} className={button}>
            Snooze 7 days
          </button>
          <button type="submit" name="days" value="30" disabled={busy} className={button}>
            Snooze 30 days
          </button>
        </fetcher.Form>
      )}
    </div>
  );
}

/**
 * Home's cross-app findings (G-GZR3-1). Plain cards: what was found, the
 * measured numbers, what the figure leaves out, which app each part came
 * from, and a link to the orders behind it. No recommendations or money
 * estimates yet; those arrive per detector after its backtest.
 */

type Money = { amount: string; currency: string };
const money = (m: Money) => `${formatAmount(m.amount)} ${m.currency}`;
const n = (x: number) => x.toLocaleString("en-GB");

type CardProps = { id: string; days: number; canManage: boolean };

function Card({
  title,
  children,
  link,
  id,
  canManage,
}: {
  title: ReactNode;
  children: ReactNode;
  link?: { to: string; label: string };
  id: string;
  canManage: boolean;
}) {
  return (
    <article className="rounded-2xl border border-gray-200 bg-white p-5">
      <h3 className="text-base font-semibold text-gray-900">{title}</h3>
      <div className="mt-2 space-y-2 text-sm text-gray-700">{children}</div>
      {link ? (
        <Link to={via(id, link.to)} className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-primary-600 hover:underline">
          {link.label} <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      ) : null}
      {canManage ? <InsightActions id={id} /> : null}
    </article>
  );
}

function Leaves({ items }: { items: ReactNode[] }) {
  return (
    <ul className="list-disc space-y-0.5 pl-5 text-xs text-gray-500">
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}

/** Which app decided the outcomes a card rests on (rule #7). */
function Sources({ by, extra }: { by: DecidedBy; extra?: string }) {
  const parts = [
    by.courierify ? `Courierify (the courier) for ${n(by.courierify)}` : null,
    by.financify ? `Financify for ${n(by.financify)}` : null,
  ].filter(Boolean);
  return (
    <p className="text-xs text-gray-500">
      Delivery outcomes: {parts.length ? parts.join(", ") : "none"} order(s).{extra ? ` ${extra}` : ""}
    </p>
  );
}

function DisagreementCard({ f, days, id, canManage }: { f: DisagreementFinding } & CardProps) {
  return (
    <Card
      id={id}
      canManage={canManage}
      title={`Courierify and Financify disagree on what happened to ${n(f.total)} orders`}
      link={{ to: `/orders?days=${days}&disagree=1`, label: `See the ${n(f.total)} orders` }}
    >
      <p>
        Growzar takes the courier's answer, through Courierify (rule #7). Financify's own screens count these
        orders differently:
      </p>
      <ul className="space-y-1">
        {f.groups.map((g) => (
          <li key={`${g.financify}|${g.courier}`} className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-medium tabular-nums">{n(g.orders)}</span>
            <span>
              Financify says <strong>{outcomeLabel(g.financify).toLowerCase()}</strong>, the courier says{" "}
              <strong>{outcomeLabel(g.courier).toLowerCase()}</strong>
            </span>
            {g.placed.length ? (
              <span className="text-xs text-gray-500">
                placed value <MoneyList values={g.placed} />
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      <p className="text-xs text-gray-500">
        Out of {n(f.bothApps)} orders in this period that both apps know about. “Booked” against “pending” is left
        out: both mean not shipped yet.
      </p>
    </Card>
  );
}

const rateLine = (v: VariantRate) =>
  `${v.returnRate.toFixed(1)}% returned (${n(v.returned)} of ${n(v.decided)} decided orders${v.stillOpen ? `, ${n(v.stillOpen)} still open` : ""})`;

function VariantCard({ f, days, id, canManage }: { f: VariantReturnsFinding } & CardProps) {
  return (
    <Card id={id} canManage={canManage} title={`${f.flagged.length === 1 ? "A product comes" : `${f.flagged.length} products come`} back far more often than the rest`}>
      <ul className="space-y-1.5">
        {f.flagged.map((v) => (
          <li key={v.variantId}>
            <span className="font-medium">{v.title ?? `Variant ${v.variantId}`}</span>: {rateLine(v)}{" "}
            <Link to={via(id, `/orders?days=${days}&variant=${v.variantId}`)} className="whitespace-nowrap text-primary-600 hover:underline">
              see orders
            </Link>
          </li>
        ))}
      </ul>
      {f.bestSellers.length ? (
        <p>
          Your best sellers:{" "}
          {f.bestSellers.map((v, i) => (
            <span key={v.variantId}>
              {i ? "; " : ""}
              {v.title ?? `variant ${v.variantId}`}, {rateLine(v)}
            </span>
          ))}
          .
        </p>
      ) : null}
      <p>
        The whole store: {f.store.returnRate.toFixed(1)}% ({n(f.store.returned)} of {n(f.store.decided)}).
      </p>
      <Leaves
        items={[
          "Counted by order: no app records which item of a returned order came back, so a returned order counts against every product in it.",
          `Only products with at least 30 decided orders are compared.${f.internationalExcluded ? ` ${n(f.internationalExcluded)} international order(s) are left out: they never get a delivery outcome.` : ""}`,
        ]}
      />
      <Sources by={f.decidedBy} extra="Products and order lines from Financify." />
    </Card>
  );
}

function MarginCard({ f, days, id, canManage }: { f: MarginFinding } & CardProps) {
  const negative = f.ceiling.amount.startsWith("-");
  const leaves: ReactNode[] = [
    `Courier fees on ${n(f.feesUnknown.orders)} of ${n(f.feesUnknown.shipped)} shipped orders: not recorded.`,
    "What a return costs (the return fee, goods that cannot be sold again): no app records it.",
  ];
  if (f.cogsIncompleteOrders) leaves.push(`COGS is incomplete on ${n(f.cogsIncompleteOrders)} delivered order(s).`);
  if (f.excludedCurrencies.length) leaves.push(`Orders in ${f.excludedCurrencies.join(", ")} are left out, not converted.`);
  return (
    <Card
      id={id}
      canManage={canManage}
      title={`Ads took ${f.adsShareOfDelivered.toFixed(1)}% of delivered revenue`}
      link={{ to: `/finance?days=${days}`, label: "See the arithmetic" }}
    >
      <p>
        Delivered orders brought <strong>{money(f.deliveredRevenue)}</strong>. Less their COGS ({money(f.cogsDelivered)}), ad
        spend with platform fees ({money(f.adSpend)})
        {f.feesUnknown.orders < f.feesUnknown.shipped ? <> and the courier fees that are known ({money(f.knownCourierFees)})</> : null},
        that leaves{" "}
        <strong>{negative ? `a loss of ${money({ ...f.ceiling, amount: f.ceiling.amount.slice(1) })}` : `at most ${money(f.ceiling)}`}</strong>
        , before the rest of the courier fees and the cost of returns.
      </p>
      <p className="text-xs font-medium text-gray-600">Not subtracted yet:</p>
      <Leaves items={leaves} />
      {f.stillOpen.orders ? (
        <p className="text-xs text-gray-500">
          It can still go up: {n(f.stillOpen.orders)} order(s) placed in this period are still open (placed value{" "}
          {money(f.stillOpen.placed)}). Each one delivered adds its revenue less its COGS; ad spend is already counted in full.
        </p>
      ) : null}
      <Sources by={f.decidedBy} extra="Revenue, COGS and ad spend from Financify." />
    </Card>
  );
}

function CourierifyStoppedCard({ f, days, id, canManage }: { f: CourierifyStoppedFinding } & CardProps) {
  return (
    <Card
      id={id}
      canManage={canManage}
      title={`Orders stopped going through Courierify after ${f.lastParcelDay}`}
      link={{ to: `/orders?days=${days}&decidedBy=financify`, label: "See the orders Courierify did not ship" }}
    >
      <p>
        Only {n(f.withParcel)} of {n(f.shipped)} shipped orders in this period were booked through Courierify. The last
        such order was placed on {f.lastParcelDay}.
      </p>
      <p>
        Delivery status for the rest comes from Financify alone. For them Growzar has no courier delivery times, no city
        and no courier fees, so comparisons by city or courier and any profit after courier fees stop at that date.
      </p>
    </Card>
  );
}

function MissingFeesCard({ f, days, id, canManage }: { f: MissingFeesFinding } & CardProps) {
  const top = f.byCourier.slice(0, 4);
  return (
    <Card
      id={id}
      canManage={canManage}
      title={`No courier fee recorded on ${n(f.missing)} of ${n(f.viaCourierify)} orders shipped through Courierify`}
      link={{ to: `/orders?days=${days}&feeMissing=1`, label: `See the ${n(f.missing)} orders` }}
    >
      <p>
        Courierify holds no courier cost for these parcels, so neither Financify nor Growzar can subtract it, and every
        profit figure that includes them reads higher than it is.
      </p>
      <ul className="space-y-0.5 text-xs text-gray-600">
        {top.map((c) => (
          <li key={c.courier}>
            {c.courier}: {n(c.missing)} of {n(c.shipped)} without a fee
          </li>
        ))}
        {f.byCourier.length > top.length ? <li>and {n(f.byCourier.length - top.length)} more courier(s)</li> : null}
      </ul>
      <Leaves
        items={[
          ...(f.via3pl ? [`${n(f.via3pl)} of them went through a 3PL, whose charges may sit with the 3PL rather than in Courierify.`] : []),
          ...(f.outsideCourierify ? [`${n(f.outsideCourierify)} more shipped order(s) did not go through Courierify at all, so no app records their fee.`] : []),
          "How much this understates costs is not estimated yet: that waits until the estimate has been checked against past data.",
        ]}
      />
    </Card>
  );
}

const payerName = (p: string) => (p === "orio" ? "Orio" : p === "tcs" ? "TCS" : p.charAt(0).toUpperCase() + p.slice(1));

function CashHeldCard({ f, days, id, canManage }: { f: CashHeldFinding } & CardProps) {
  const who = payerName(f.payer);
  return (
    <Card
      id={id}
      canManage={canManage}
      title={`No payout recorded from ${who} for ${n(f.orders)} delivered order${f.orders === 1 ? "" : "s"}`}
      link={{ to: `/orders?days=${days}&awaitingPayout=${f.payer}`, label: `See the ${n(f.orders)} orders` }}
    >
      <p>
        COD of <MoneyList values={f.cod} />, delivered
        {f.oldestDay ? ` from ${f.oldestDay}` : ""}, with no {who} payout recorded in Courierify.
      </p>
      <p>
        {who} usually paid this store every {f.medianGapDays} day{f.medianGapDays === 1 ? "" : "s"}. Its last payout in
        Courierify was on {f.lastPaidDay}
        {f.daysLate > 0 ? `, ${n(f.daysLate)} days later than that rhythm would have it.` : "."}
      </p>
      <p className="text-xs text-gray-600">
        This is what Courierify has recorded. A payout made outside it, straight to your bank or on {who}'s own
        statement, would not show here: check that statement before chasing.
      </p>
      <Leaves
        items={[
          `As of ${f.asOf}, whatever the order date: only orders delivered more than ${f.dueAfterDays} days ago count.`,
          ...(f.disputed
            ? [`Courierify also marks ${n(f.disputed)} ${who} statement(s) as disputed. They are not added in: a statement can cover parcels already paid in other payouts.`]
            : []),
          ...(f.notJudged.length
            ? [`Not judged: ${f.notJudged.map((p) => `${payerName(p.payer)} (${n(p.orders)} orders)`).join(", ")}. Courierify has too few of their payouts to know when they pay.`]
            : []),
        ]}
      />
    </Card>
  );
}

function UnconfirmedCard({ f, days, id, canManage }: { f: UnconfirmedFinding } & CardProps) {
  const ratio = f.confirmed.returnRate ? f.unanswered.returnRate / f.confirmed.returnRate : null;
  return (
    <Card
      id={id}
      canManage={canManage}
      title={`Orders nobody confirmed come back ${ratio ? `${ratio.toFixed(1)}× as often` : "more often"}`}
      link={f.waiting ? { to: `/orders?days=${days}&unanswered=waiting`, label: `See the ${n(f.waiting)} waiting to be confirmed` } : undefined}
    >
      <p>
        Asked on WhatsApp and never answered: <strong>{f.unanswered.returnRate.toFixed(1)}%</strong> returned (
        {n(f.unanswered.returned)} of {n(f.unanswered.decided)}). Confirmed: {f.confirmed.returnRate.toFixed(1)}% (
        {n(f.confirmed.returned)} of {n(f.confirmed.decided)}). That is {n(f.excessReturns)} more returns than the confirmed
        rate would give.
      </p>
      {f.waiting ? (
        <p>
          {n(f.waiting)} unanswered order{f.waiting === 1 ? "" : "s"} from the last 7 days {f.waiting === 1 ? "has" : "have"} not gone
          to the courier yet: a call before booking can still confirm or cancel {f.waiting === 1 ? "it" : "them"}.
        </p>
      ) : null}
      {f.declinedShipped ? (
        <p>
          {n(f.declinedShipped.decided)} orders the buyer <strong>declined</strong> were shipped anyway, and{" "}
          {f.declinedShipped.returnRate.toFixed(1)}% of them came back.
        </p>
      ) : null}
      <Leaves
        items={[
          `${n(f.noRecord)} order(s) have no WhatsApp confirmation record and are left out: voice confirmations are not synced, so they may have been confirmed.`,
          "Counted by order outcome, domestic orders only. What these returns cost is not estimated yet.",
        ]}
      />
      <Sources by={f.decidedBy} extra="Confirmations from Courierify." />
    </Card>
  );
}

export function InboxCards({ inbox, from, to }: { inbox: InboxView; from: string; to: string }) {
  const reopen = useFetcher();
  return (
    <section className="space-y-3" aria-labelledby="findings-heading">
      <div>
        <h2 id="findings-heading" className="text-lg font-semibold text-gray-900">
          What Growzar found
        </h2>
        <p className="text-xs text-gray-500">
          {from} to {to}. Measured from your connected apps, each with the orders behind it. Recommendations and
          estimates of what each is worth come once each finding has been checked against past data. Every finding so far
          comes from one store's history.
        </p>
      </div>
      {inbox.items.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-gray-300 bg-white p-5 text-sm text-gray-600">
          Nothing to show in this period. What was checked, and why it found nothing, is listed below.
        </p>
      ) : (
        inbox.items.map(({ id, insight }) => {
          const props = { id, days: inbox.days, canManage: inbox.canManage };
          const f = insight.finding;
          switch (f.kind) {
            case "disagreements":
              return <DisagreementCard key={id} f={f} {...props} />;
            case "variant_returns":
              return <VariantCard key={id} f={f} {...props} />;
            case "margin":
              return <MarginCard key={id} f={f} {...props} />;
            case "courierify_stopped":
              return <CourierifyStoppedCard key={id} f={f} {...props} />;
            case "missing_fees":
              return <MissingFeesCard key={id} f={f} {...props} />;
            case "cash_held":
              return <CashHeldCard key={id} f={f} {...props} />;
            case "unconfirmed_returns":
              return <UnconfirmedCard key={id} f={f} {...props} />;
          }
        })
      )}
      {inbox.overflow ? (
        <p className="text-xs text-gray-500">{n(inbox.overflow)} more found; dismiss or snooze one to see the next.</p>
      ) : null}
      {inbox.hidden.length ? (
        <details className="rounded-xl border border-gray-200 bg-white p-3.5 text-sm">
          <summary className="cursor-pointer text-gray-700">Dismissed and snoozed ({n(inbox.hidden.length)})</summary>
          <ul className="mt-2 space-y-1.5">
            {inbox.hidden.map((h) => (
              <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 text-xs text-gray-600">
                <span>
                  {h.label} ·{" "}
                  {h.status === "dismissed"
                    ? `dismissed: ${REASONS.find(([v]) => v === h.reason)?.[1] ?? "no reason"}`
                    : `snoozed until ${h.snoozedUntil?.slice(0, 10)}`}
                </span>
                {inbox.canManage ? (
                  <reopen.Form method="post" action={`/insights/${h.id}`}>
                    <input type="hidden" name="intent" value="reopen" />
                    <button type="submit" className="text-primary-600 hover:underline">
                      Reopen
                    </button>
                  </reopen.Form>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {inbox.checked.length ? (
        <details className="rounded-xl border border-gray-200 bg-white p-3.5 text-sm">
          <summary className="cursor-pointer text-gray-700">Also checked ({n(inbox.checked.length)})</summary>
          <ul className="mt-2 space-y-1.5 text-xs text-gray-600">
            {inbox.checked.map((c) => (
              <li key={c.label}>
                <span className="font-medium text-gray-700">{c.label}</span>:{" "}
                {c.status === "nothing_found" ? "nothing found" : c.status === "not_enough_data" ? "not enough data" : "locked"} ({c.text}).
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
