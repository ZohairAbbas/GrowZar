import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useFetcher } from "react-router";
import { ArrowRight, ChevronLeft, ChevronRight, Database, Lightbulb, Package, Target, Truck, Undo2, Wallet, X } from "lucide-react";

import type {
  CashHeldFinding,
  CostEstimate,
  CityReturnsFinding,
  ProductLossFinding,
  CourierCityFinding,
  UnconfirmedFinding,
  CourierifyStoppedFinding,
  DecidedBy,
  DisagreementFinding,
  Finding,
  MarginFinding,
  MissingFeesFinding,
  VariantReturnsFinding,
  VariantRate,
  StuckFinding,
  NotReceivedFinding,
  DeductionsFinding,
} from "~/lib/metrics/findings";
import type { StockoutFinding } from "~/lib/metrics/stockout";
import type { InboxItem, InboxView } from "~/lib/insights/inbox.server";
import { DISMISS_REASONS } from "~/lib/insights/actions";
import { formatAmount, MoneyList, outcomeLabel } from "./Metrics";

/**
 * Which part of the business a card is about, shown as a small tag above its
 * title. Set per card by InboxCards, so the cards themselves stay unchanged.
 */
const Area = createContext<Finding["kind"] | null>(null);

const AREAS: Record<Finding["kind"], { label: string; Icon: typeof Wallet; tint: string }> = {
  cash_held: { label: "Money owed", Icon: Wallet, tint: "bg-coral-100 text-coral-700" },
  margin: { label: "Profit", Icon: Wallet, tint: "bg-coral-100 text-coral-700" },
  product_loss: { label: "Profit", Icon: Wallet, tint: "bg-coral-100 text-coral-700" },
  unconfirmed_returns: { label: "Returns", Icon: Undo2, tint: "bg-mint-100 text-mint-700" },
  variant_returns: { label: "Returns", Icon: Undo2, tint: "bg-mint-100 text-mint-700" },
  city_returns: { label: "Returns", Icon: Undo2, tint: "bg-mint-100 text-mint-700" },
  courier_for_city: { label: "Shipping", Icon: Truck, tint: "bg-data-100 text-data-700" },
  disagreements: { label: "Data check", Icon: Database, tint: "bg-field text-gray-600" },
  missing_fees: { label: "Data check", Icon: Database, tint: "bg-field text-gray-600" },
  courierify_stopped: { label: "Data check", Icon: Database, tint: "bg-field text-gray-600" },
  stuck_parcels: { label: "Shipping", Icon: Truck, tint: "bg-data-100 text-data-700" },
  returns_not_received: { label: "Returns", Icon: Undo2, tint: "bg-mint-100 text-mint-700" },
  courier_deductions: { label: "Money owed", Icon: Wallet, tint: "bg-coral-100 text-coral-700" },
  stockout: { label: "Stock", Icon: Package, tint: "bg-data-100 text-data-700" },
};

function AreaTag() {
  const kind = useContext(Area);
  const area = kind ? AREAS[kind] : null;
  if (!area) return null;
  return (
    <div className="flex items-center gap-2.5">
      <span className={`flex h-9 w-9 items-center justify-center rounded-xl ${area.tint}`}>
        <area.Icon className="h-[18px] w-[18px]" />
      </span>
      <span className="text-sm font-semibold text-gray-500">{area.label}</span>
    </div>
  );
}

/** Through the click-through route, which records the click (G-GZR3-3). */
const via = (id: string, to: string) => `/insights/${id}/open?to=${encodeURIComponent(to)}`;

const REASONS = Object.entries(DISMISS_REASONS);

function InsightActions({ id }: { id: string }) {
  const fetcher = useFetcher();
  const [dismissing, setDismissing] = useState(false);
  const busy = fetcher.state !== "idle";
  const button = "rounded-full bg-field px-3.5 py-1.5 text-sm font-semibold text-gray-700 hover:bg-gray-100 disabled:opacity-50";
  return (
    <div className="mt-5 border-t border-gray-100 pt-4">
      {dismissing ? (
        <fetcher.Form method="post" action={`/insights/${id}`} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="intent" value="dismiss" />
          <label className="text-sm font-semibold text-gray-600" htmlFor={`reason-${id}`}>
            Why?
          </label>
          <select id={`reason-${id}`} name="reason" required defaultValue="" className="rounded-full border border-gray-200 px-3 py-1.5 text-sm">
            <option value="" disabled>
              Choose a reason
            </option>
            {REASONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <input name="note" maxLength={500} placeholder="Note (optional)" className="min-w-0 flex-1 rounded-full border border-gray-200 px-3 py-1.5 text-sm" />
          <button type="submit" disabled={busy} className={button}>
            Dismiss
          </button>
          <button type="button" onClick={() => setDismissing(false)} className="text-sm font-semibold text-gray-500 hover:underline">
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

type CardProps = { id: string; period: string; canManage: boolean };

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
    <article className="rounded-2xl bg-white p-6">
      <AreaTag />
      <h3 className="mt-3 font-display text-xl font-bold leading-tight text-gray-900">{title}</h3>
      <div className="mt-2.5 space-y-2 text-sm leading-relaxed text-gray-700">{children}</div>
      {link ? (
        <Link
          to={via(id, link.to)}
          className="mt-4 inline-flex items-center gap-2 rounded-full bg-navy px-4 py-2.5 text-sm font-semibold text-white hover:bg-navy-surface"
        >
          {link.label} <ArrowRight className="h-4 w-4 text-mint" />
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

function DisagreementCard({ f, period, id, canManage }: { f: DisagreementFinding } & CardProps) {
  return (
    <Card
      id={id}
      canManage={canManage}
      title={`Courierify and Financify disagree on what happened to ${n(f.total)} orders`}
      link={{ to: `/orders?${period}&disagree=1`, label: `See the ${n(f.total)} orders` }}
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

function VariantCard({ f, period, id, canManage }: { f: VariantReturnsFinding } & CardProps) {
  return (
    <Card id={id} canManage={canManage} title={`${f.flagged.length === 1 ? "A product comes" : `${f.flagged.length} products come`} back far more often than the rest`}>
      <ul className="space-y-1.5">
        {f.flagged.map((v) => (
          <li key={v.variantId}>
            <span className="font-medium">{v.title ?? `Variant ${v.variantId}`}</span>: {rateLine(v)}
            {v.cost ? `, ${n(v.excessReturns ?? 0)} more than the store's rate would give, about ${money(v.cost.total)} in courier charges` : ""}{" "}
            <Link to={via(id, `/orders?${period}&variant=${v.variantId}`)} className="whitespace-nowrap text-primary-600 hover:underline">
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
          ...(f.flagged.some((v) => v.cost) ? [costBasis(f.flagged.find((v) => v.cost)!.cost!)] : []),
          `Only products with at least 30 decided orders are compared.${f.internationalExcluded ? ` ${n(f.internationalExcluded)} international order(s) are left out: they never get a delivery outcome.` : ""}`,
        ]}
      />
      <Sources by={f.decidedBy} extra="Products and order lines from Financify." />
    </Card>
  );
}

function MarginCard({ f, period, id, canManage }: { f: MarginFinding } & CardProps) {
  const negative = f.ceiling.amount.startsWith("-");
  const leaves: ReactNode[] = [
    `Courier fees on ${n(f.feesUnknown.orders)} of ${n(f.feesUnknown.shipped)} shipped orders: not recorded.`,
    "Goods that cannot be sold again after a return: no app records them. Courier charges on returns are subtracted where recorded.",
  ];
  if (f.cogsIncompleteOrders) leaves.push(`COGS is incomplete on ${n(f.cogsIncompleteOrders)} delivered order(s).`);
  if (f.excludedCurrencies.length) leaves.push(`Orders in ${f.excludedCurrencies.join(", ")} are left out, not converted.`);
  return (
    <Card
      id={id}
      canManage={canManage}
      title={`Ads took ${f.adsShareOfDelivered.toFixed(1)}% of delivered revenue`}
      link={{ to: `/finance?${period}`, label: "See the arithmetic" }}
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

function CourierifyStoppedCard({ f, period, id, canManage }: { f: CourierifyStoppedFinding } & CardProps) {
  return (
    <Card
      id={id}
      canManage={canManage}
      title={`Orders stopped going through Courierify after ${f.lastParcelDay}`}
      link={{ to: `/orders?${period}&decidedBy=financify`, label: "See the orders Courierify did not ship" }}
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

function StuckCard({ f, period, id, canManage }: { f: StuckFinding } & CardProps) {
  return (
    <Card
      id={id}
      canManage={canManage}
      title={`${n(f.booked + f.inTransit)} parcels have not moved for days`}
      link={{ to: `/orders?${period}&stuck=1`, label: `See the ${n(f.booked + f.inTransit)} orders` }}
    >
      <p>
        {f.booked ? <>{n(f.booked)} were booked 3 or more days ago and the courier has not picked them up. </> : null}
        {f.inTransit ? <>{n(f.inTransit)} have been in transit for 7 or more days with no update from the courier. </> : null}
        {f.placed ? <>Together they hold <strong>{money(f.placed)}</strong> of orders. </> : null}
        The oldest has not moved for {n(f.oldestDays)} days.
      </p>
      <ul className="space-y-0.5 text-xs text-gray-600">
        {f.byCourier.slice(0, 4).map((c) => (
          <li key={c.courier}>
            {payerName(c.courier)}: {n(c.orders)}
          </li>
        ))}
      </ul>
      <Leaves items={["Only parcels booked through Courierify: the status time is Courierify's own, so a parcel booked elsewhere cannot be judged."]} />
    </Card>
  );
}

const variantName = (f: StockoutFinding) => (f.variantTitle ? `${f.title} (${f.variantTitle})` : f.title);
const stockoutHeadline = (f: StockoutFinding) =>
  f.situation === "out"
    ? `${variantName(f)} is out of stock while selling ${f.perDay.toFixed(1)} a day`
    : `${variantName(f)} runs out in about ${n(f.daysOfCover)} day${f.daysOfCover === 1 ? "" : "s"}, before a reorder could arrive`;

function StockoutCard({ f, id, canManage }: { f: StockoutFinding } & CardProps) {
  return (
    <Card id={id} canManage={canManage} title={stockoutHeadline(f)} link={{ to: "/inventory?days=30", label: "See stock" }}>
      <p>
        {f.situation === "out" ? (
          <>It has no stock left, and sold {f.perDay.toFixed(1)} a day over the last 30 days. </>
        ) : (
          <>
            At the last 30 days' rate ({f.perDay.toFixed(1)} a day) the {n(f.stock)} on hand last about {n(f.daysOfCover)} days.{" "}
          </>
        )}
        {f.leadSource === "measured"
          ? <>Its supplier takes {n(f.leadTimeDays)} days on average from order to delivery in Inventorify, so stock ordered today leaves about </>
          : <>Its lead time set in Inventorify is {n(f.leadTimeDays)} days, so stock ordered today leaves about </>}
        <strong>
          {n(f.shortDays)} days with nothing to sell: roughly {n(f.unitsShort)} units of demand
        </strong>
        .
        {f.orderedShare !== null ? <> It was {pct(f.orderedShare)} of the units ordered in the last {n(f.periodDays)} days.</> : null}
      </p>
      <Leaves
        items={[
          "Nothing is on order for it in Inventorify. If you have reordered outside Inventorify, dismiss this.",
          f.leadSource === "measured"
            ? "The lead time is measured on this supplier's received purchase orders."
            : "The lead time is the product's setting in Inventorify; set the real one there, or receive 3 purchase orders from its supplier, and this card follows it.",
          "No money estimate yet: what a stock-out costs is shown once it has been checked against past stock-outs.",
        ]}
      />
    </Card>
  );
}

function NotReceivedCard({ f, period, id, canManage }: { f: NotReceivedFinding } & CardProps) {
  return (
    <Card id={id} canManage={canManage} title={`${n(f.older)} returns not confirmed back after 14 days`} link={{ to: `/shipping?${period}`, label: "See returns on Shipping" }}>
      <p>
        {n(f.orders)} returned orders in this period are not marked received in Courierify, {n(f.older)} of them returned more than 14
        days ago
        {f.productCost ? <>, holding <strong>{money(f.productCost)}</strong> of product at cost</> : null}.
      </p>
      <ul className="space-y-0.5 text-xs text-gray-600">
        {f.byCourier.slice(0, 4).map((c) => (
          <li key={c.courier}>
            {payerName(c.courier)}: {n(c.orders)} not confirmed back
          </li>
        ))}
      </ul>
      <Leaves
        items={[
          "Received is the merchant's own mark in Courierify. A return that arrived but was never marked counts here too.",
          "Only returns booked through Courierify can be checked.",
        ]}
      />
    </Card>
  );
}

function DeductionsCard({ f, period, id, canManage }: { f: DeductionsFinding } & CardProps) {
  return (
    <Card
      id={id}
      canManage={canManage}
      title={`${payerName(f.payer)} kept COD its statement does not explain`}
      link={{ to: `/finance?${period}`, label: "See courier deductions on Finance" }}
    >
      <p>
        On {n(f.statements)} statement{f.statements === 1 ? "" : "s"} dated in this period, {payerName(f.payer)} collected{" "}
        <strong>{money(f.cod)}</strong> and paid <strong>{money(f.netPaid)}</strong>. Of what it kept,{" "}
        <strong>{money(f.unitemized)}</strong> ({pct(f.unitemizedShare)} of COD) is not itemized as a fee, tax or other deduction.
      </p>
      <Leaves
        items={[
          "Itemized: COD fee, delivery fees, return fees, withholding tax, other deductions and carry-forward, as Courierify records the statement.",
          ...(f.keptShare !== null ? [`In all the courier kept ${pct(f.keptShare)} of the COD.`] : []),
        ]}
      />
    </Card>
  );
}

function MissingFeesCard({ f, period, id, canManage }: { f: MissingFeesFinding } & CardProps) {
  const top = f.byCourier.slice(0, 4);
  return (
    <Card
      id={id}
      canManage={canManage}
      title={`No courier fee recorded on ${n(f.missing)} of ${n(f.viaCourierify)} orders shipped through Courierify`}
      link={{ to: `/orders?${period}&feeMissing=1`, label: `See the ${n(f.missing)} orders` }}
    >
      <p>
        Courierify holds no courier cost for these parcels, so neither Financify nor Growzar can subtract it, and every
        profit figure that includes them reads higher than it is
        {f.estimate ? <>, by about <strong>{money(f.estimate.total)}</strong></> : null}.
      </p>
      <ul className="space-y-0.5 text-xs text-gray-600">
        {top.map((c) => (
          <li key={c.courier}>
            {payerName(c.courier)}: {n(c.missing)} of {n(c.shipped)} without a fee
          </li>
        ))}
        {f.byCourier.length > top.length ? <li>and {n(f.byCourier.length - top.length)} more courier(s)</li> : null}
      </ul>
      <Leaves
        items={[
          ...(f.via3pl ? [`${n(f.via3pl)} of them went through a 3PL, whose charges may sit with the 3PL rather than in Courierify.`] : []),
          ...(f.outsideCourierify ? [`${n(f.outsideCourierify)} more shipped order(s) did not go through Courierify at all, so no app records their fee.`] : []),
          f.estimate
            ? `An estimate: ${n(f.missing)} × ${money(f.estimate.medianFee)}, the median fee on ${n(f.estimate.pricedOrders)} orders in this period that have one. Orio-booked parcels may be charged by Orio rather than Courierify.`
            : "How much this understates costs is not estimated: fewer than 30 orders in this period have a fee to go on.",
        ]}
      />
    </Card>
  );
}

/** Display names for the identifiers Courierify uses; anything else is capitalised. */
const COURIER_NAMES: Record<string, string> = {
  orio: "Orio",
  tcs: "TCS",
  nkfulfillment: "NK Fulfilment",
  blueex: "BlueEx",
  postex: "PostEx",
  smartlane: "SmartLane",
  trax: "Trax",
  leopards: "Leopards",
  bouraq: "Bouraq",
};
const payerName = (p: string) => COURIER_NAMES[p] ?? p.charAt(0).toUpperCase() + p.slice(1);

function CashHeldCard({ f, period, id, canManage }: { f: CashHeldFinding } & CardProps) {
  const who = payerName(f.payer);
  return (
    <Card
      id={id}
      canManage={canManage}
      title={`No payout recorded from ${who} for ${n(f.orders)} delivered order${f.orders === 1 ? "" : "s"}`}
      link={{ to: `/orders?${period}&awaitingPayout=${f.payer}`, label: `See the ${n(f.orders)} orders` }}
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

/** Courier charges on returns: how the figure was reached. */
function costBasis(c: CostEstimate): string {
  return `Courier charges at ${money(c.perReturn)} per return, the median charge on ${n(c.pricedReturns)} returned parcels whose charge Courierify records. Goods that cannot be sold again are not included: no app records them.`;
}

function ReturnsCostLine({ cost }: { cost: CostEstimate }) {
  return (
    <>
      <p>
        Those {n(cost.returns)} extra returns cost about <strong>{money(cost.total)}</strong> in courier charges.
      </p>
      <p className="text-xs text-gray-500">{costBasis(cost)}</p>
    </>
  );
}

function UnconfirmedCard({ f, period, id, canManage }: { f: UnconfirmedFinding } & CardProps) {
  const ratio = f.confirmed.returnRate ? f.unanswered.returnRate / f.confirmed.returnRate : null;
  return (
    <Card
      id={id}
      canManage={canManage}
      title={`Orders nobody confirmed come back ${ratio ? `${ratio.toFixed(1)}× as often` : "more often"}`}
      link={f.waiting ? { to: `/orders?${period}&unanswered=waiting`, label: `See the ${n(f.waiting)} waiting to be confirmed` } : undefined}
    >
      <p>
        Asked on WhatsApp and never answered: <strong>{f.unanswered.returnRate.toFixed(1)}%</strong> returned (
        {n(f.unanswered.returned)} of {n(f.unanswered.decided)}). Confirmed: {f.confirmed.returnRate.toFixed(1)}% (
        {n(f.confirmed.returned)} of {n(f.confirmed.decided)}). That is {n(f.excessReturns)} more returns than the confirmed
        rate would give.
      </p>
      {f.cost ? <ReturnsCostLine cost={f.cost} /> : null}
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

const routeName = (r: { courier: string; via: string }) =>
  `${payerName(r.courier)}${r.via === "direct" ? ", booked directly" : ` through ${payerName(r.via)}`}`;

function CourierCityCard({ f, period, id, canManage }: { f: CourierCityFinding } & CardProps) {
  const w = f.worse[0]!;
  const list = (r: { courier: string; via: string }) =>
    via(id, `/orders?${period}&city=${encodeURIComponent(f.city)}&courier=${r.courier}&via=${r.via}`);
  return (
    <Card
      id={id}
      canManage={canManage}
      title={`In ${f.city}, ${routeName(f.best)} delivered ${w.gapPoints.toFixed(1)} points more than ${routeName(w)}`}
    >
      <ul className="space-y-1">
        {[f.best, ...f.worse].map((r) => (
          <li key={`${r.courier}|${r.via}`} className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-medium">{routeName(r)}</span>
            <span>
              {r.rate.toFixed(1)}% delivered ({n(r.delivered)} of {n(r.decided)})
            </span>
            <Link to={list(r)} className="text-xs text-primary-600 hover:underline">
              see orders
            </Link>
          </li>
        ))}
      </ul>
      <Leaves
        items={[
          `Orders placed ${[f.best, ...f.worse].map((r) => r.firstDay).sort()[0]} to ${f.lastDay}. Routes compare orders shipped through Courierify only: Financify names the carrier but not how the parcel was booked.`,
          "The gap is unlikely to be chance alone (95%), but what was sent each way, and when, can also differ.",
          "Fees are not compared: they are recorded on only part of these orders. What the gap is worth is not estimated yet.",
        ]}
      />
    </Card>
  );
}

const unsigned = (m: Money) => ({ ...m, amount: m.amount.replace(/^-/, "") });

function ProductLossCard({ f, period, id, canManage }: { f: ProductLossFinding } & CardProps) {
  return (
    <Card
      id={id}
      canManage={canManage}
      title={`${f.title ?? `Variant ${f.variantId}`} loses money once returns are counted`}
      link={{ to: `/orders?${period}&variant=${f.variantId}`, label: `See its ${n(f.orders)} orders` }}
    >
      <p>
        Had every order been delivered, it would have made {money(f.ifAllDelivered)} after its cost and its ad spend. As
        delivered, it lost <strong>at least {money(unsigned(f.ceiling))}</strong> ({money(unsigned(f.per30Days))} per 30
        days): {f.returnRate.toFixed(1)}% of its orders came back ({n(f.returned)} of {n(f.decided)}).
      </p>
      <p className="text-xs text-gray-600">
        Delivered value {money(f.deliveredValue)} − cost {money(f.deliveredCost)} − ad spend {money(f.adSpend)}.
      </p>
      <p className="text-xs font-medium text-gray-600">“At least”, because these are not subtracted yet:</p>
      <Leaves
        items={[
          "Courier fees and the cost of returns: not recorded for most orders.",
          "Ad platform fees: the ad spend is Financify's allocation to this product, before fees.",
          ...(f.linesWithoutCost ? [`Cost on ${n(f.linesWithoutCost)} delivered line(s) that have none recorded.`] : []),
          ...(f.stillOpen ? [`${n(f.stillOpen)} order(s) are still open; if delivered they would add to it.`] : []),
          "Counted by order: no app records which item of a returned order came back, so a returned order counts against every product in it.",
        ]}
      />
    </Card>
  );
}

function CityReturnsCard({ f, period, id, canManage }: { f: CityReturnsFinding } & CardProps) {
  return (
    <Card
      id={id}
      canManage={canManage}
      title={`Orders to ${f.city} come back far more often than the rest`}
      link={{ to: `/orders?${period}&city=${encodeURIComponent(f.city)}`, label: `See the ${n(f.orders)} orders` }}
    >
      <p>
        {f.city}: <strong>{f.returnRate.toFixed(1)}%</strong> returned ({n(f.returned)} of {n(f.decided)}). The rest of
        the store: {f.rest.returnRate.toFixed(1)}% ({n(f.rest.returned)} of {n(f.rest.decided)}). Unlikely to be chance
        alone (95%).
      </p>
      <Leaves
        items={[
          "Profit for the city is not shown: ad spend is not split by city, and courier fees and return costs are recorded for too few orders.",
          `City from Courierify, or Financify's delivery address in Courierify's city names where this store's orders show which name a spelling means. The latest compared is from ${f.lastDay}.`,
        ]}
      />
    </Card>
  );
}

export function InboxCards({ inbox, from, to, period }: { inbox: InboxView; from: string; to: string; period: string }) {
  const reopen = useFetcher();
  return (
    <section className="space-y-3" aria-labelledby="findings-heading">
      <div>
        <h2 id="findings-heading" className="font-display text-xl font-bold text-gray-900">
          What Growzar found{" "}
          {inbox.items.length ? <span className="font-sans text-base font-semibold text-gray-500">· {n(inbox.items.length)}</span> : null}
        </h2>
        <p className="mt-0.5 text-xs text-gray-500">
          {from} to {to}, measured from your connected apps. Open Details on a card for the full figures and what they
          leave out.
        </p>
      </div>
      {inbox.items.length === 0 ? (
        <p className="rounded-2xl bg-white p-6 text-sm text-gray-600">
          Nothing to show in this period. What was checked, and why it found nothing, is listed below.
        </p>
      ) : (
        <InsightCarousel items={inbox.items} period={period} canManage={inbox.canManage} />
      )}
      {inbox.overflow ? (
        <p className="text-xs text-gray-500">{n(inbox.overflow)} more found; dismiss or snooze one to see the next.</p>
      ) : null}
      {inbox.hidden.length ? (
        <details className="rounded-2xl bg-white px-5 py-4 text-sm">
          <summary className="cursor-pointer font-semibold text-gray-700">Dismissed and snoozed ({n(inbox.hidden.length)})</summary>
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
        <details className="rounded-2xl bg-white px-5 py-4 text-sm">
          <summary className="cursor-pointer font-semibold text-gray-700">Also checked ({n(inbox.checked.length)})</summary>
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

/** The full card for a finding: everything it measured and left out. Shown in Details. */
function FullCard({ item, period, canManage }: { item: InboxItem; period: string; canManage: boolean }) {
  const { id, insight } = item;
  const props = { id, period, canManage };
  const f = insight.finding;
  const card = (() => {
    switch (f.kind) {
      case "disagreements":
        return <DisagreementCard f={f} {...props} />;
      case "variant_returns":
        return <VariantCard f={f} {...props} />;
      case "margin":
        return <MarginCard f={f} {...props} />;
      case "courierify_stopped":
        return <CourierifyStoppedCard f={f} {...props} />;
      case "missing_fees":
        return <MissingFeesCard f={f} {...props} />;
      case "cash_held":
        return <CashHeldCard f={f} {...props} />;
      case "unconfirmed_returns":
        return <UnconfirmedCard f={f} {...props} />;
      case "courier_for_city":
        return <CourierCityCard f={f} {...props} />;
      case "product_loss":
        return <ProductLossCard f={f} {...props} />;
      case "city_returns":
        return <CityReturnsCard f={f} {...props} />;
      case "stuck_parcels":
        return <StuckCard f={f} {...props} />;
      case "returns_not_received":
        return <NotReceivedCard f={f} {...props} />;
      case "courier_deductions":
        return <DeductionsCard f={f} {...props} />;
      case "stockout":
        return <StockoutCard f={f} {...props} />;
    }
  })();
  return <Area.Provider value={f.kind}>{card}</Area.Provider>;
}

/**
 * The face of a compact card. Every figure and sentence comes from the
 * finding or from its full card's own text: "next" only where that text
 * already says what to do, otherwise "why" quotes what the figure means. No
 * recommendation or money is made up here: an estimate appears only when the
 * finding carries one (approved per detector, 2026-10-06).
 */
type Summary = {
  headline: string;
  figure: string;
  note: string;
  next?: string;
  why?: string;
  affects: string;
  link?: { to: string; label: string };
};

const pct = (x: number) => `${x.toFixed(1)}%`;
/** A headline amount: currency first, whole units, as in the metric row. */
const figure = (m: Money) => `${m.currency} ${formatAmount(m.amount).replace(/\.\d+$/, "")}`;
const first = (m: Money[]) => (m[0] ? figure(m[0]) : "—");

function summaryOf(f: Finding, period: string): Summary {
  switch (f.kind) {
    case "cash_held": {
      const who = payerName(f.payer);
      return {
        headline: `${who} hasn't paid for ${n(f.orders)} delivered order${f.orders === 1 ? "" : "s"}`,
        figure: first(f.cod),
        note: f.daysLate > 0 ? `${n(f.daysLate)} days past its usual ${f.medianGapDays}-day payout` : `Last payout ${f.lastPaidDay}`,
        next: `Check ${who}'s own statement, then chase the payout.`,
        affects: `${n(f.orders)} delivered orders`,
        link: { to: `/orders?${period}&awaitingPayout=${f.payer}`, label: "See orders" },
      };
    }
    case "unconfirmed_returns":
      return {
        headline: "Orders nobody confirmed come back more often",
        figure: f.cost ? figure(f.cost.total) : pct(f.unanswered.returnRate),
        note: f.cost
          ? `in courier charges on ${n(f.excessReturns)} extra returns: ${pct(f.unanswered.returnRate)} returned unanswered, ${pct(f.confirmed.returnRate)} confirmed`
          : `returned when unanswered, against ${pct(f.confirmed.returnRate)} when confirmed`,
        ...(f.waiting
          ? { next: `Call the ${n(f.waiting)} unanswered order${f.waiting === 1 ? "" : "s"} before booking: they can still be confirmed or cancelled.` }
          : { why: `${n(f.excessReturns)} more returns than the confirmed rate would give.` }),
        affects: `${n(f.unanswered.decided)} unanswered orders`,
        link: f.waiting ? { to: `/orders?${period}&unanswered=waiting`, label: "See orders" } : undefined,
      };
    case "variant_returns": {
      const v = f.flagged[0]!;
      const name = v.title ?? `Variant ${v.variantId}`;
      return {
        headline: f.flagged.length === 1 ? `${name} comes back far more often` : `${n(f.flagged.length)} products come back far more often`,
        figure: v.cost ? figure(v.cost.total) : pct(v.returnRate),
        note: v.cost
          ? `in courier charges on ${n(v.excessReturns ?? 0)} extra returns: ${pct(v.returnRate)} returned, ${pct(f.store.returnRate)} for the store`
          : `${f.flagged.length === 1 ? "" : `${name}: `}returned, against ${pct(f.store.returnRate)} for the whole store`,
        why: "Counted by order: a returned order counts against every product in it.",
        affects: `${n(v.decided)} decided orders`,
        link: { to: `/orders?${period}&variant=${v.variantId}`, label: "See orders" },
      };
    }
    case "margin": {
      const loss = f.ceiling.amount.startsWith("-");
      return {
        headline: `Ads took ${pct(f.adsShareOfDelivered)} of delivered revenue`,
        figure: loss ? `−${figure(unsigned(f.ceiling))}` : figure(f.ceiling),
        note: loss ? "lost after cost and ads, at least" : "left after cost and ads, at most",
        why: "Before the rest of the courier fees and the cost of returns.",
        affects: `${n(f.delivered)} delivered orders`,
        link: { to: `/finance?${period}`, label: "See the arithmetic" },
      };
    }
    case "product_loss":
      return {
        headline: `${f.title ?? `Variant ${f.variantId}`} loses money once returns are counted`,
        figure: `−${figure(unsigned(f.ceiling))}`,
        note: `lost at least, with ${pct(f.returnRate)} of its orders returned`,
        why: `Had every order been delivered it would have made ${money(f.ifAllDelivered)}.`,
        affects: `${n(f.orders)} orders`,
        link: { to: `/orders?${period}&variant=${f.variantId}`, label: "See orders" },
      };
    case "city_returns":
      return {
        headline: `Orders to ${f.city} come back far more often`,
        figure: pct(f.returnRate),
        note: `returned, against ${pct(f.rest.returnRate)} for the rest of the store`,
        why: "Unlikely to be chance alone (95%).",
        affects: `${n(f.orders)} orders`,
        link: { to: `/orders?${period}&city=${encodeURIComponent(f.city)}`, label: "See orders" },
      };
    case "courier_for_city": {
      const w = f.worse[0]!;
      return {
        headline: `In ${f.city}, ${routeName(f.best)} delivers more`,
        figure: `+${w.gapPoints.toFixed(1)} pts`,
        note: `${pct(f.best.rate)} delivered, against ${pct(w.rate)} for ${routeName(w)}`,
        why: "Unlikely to be chance alone (95%), though what went each way can differ.",
        affects: `${n(f.best.decided + w.decided)} decided orders`,
        link: {
          to: `/orders?${period}&city=${encodeURIComponent(f.city)}&courier=${f.best.courier}&via=${f.best.via}`,
          label: "See orders",
        },
      };
    }
    case "missing_fees":
      return {
        headline: "Courier fees missing on Courierify orders",
        figure: n(f.missing),
        note: `of ${n(f.viaCourierify)} orders shipped through Courierify have no fee`,
        why: f.estimate
          ? `Profit reads about ${figure(f.estimate.total)} too high (at the median fee of ${figure(f.estimate.medianFee)}).`
          : "Every profit figure that includes them reads higher than it is.",
        affects: `${n(f.missing)} shipped orders`,
        link: { to: `/orders?${period}&feeMissing=1`, label: "See orders" },
      };
    case "disagreements":
      return {
        headline: "Courierify and Financify disagree on outcomes",
        figure: n(f.total),
        note: `orders, out of ${n(f.bothApps)} both apps know about`,
        why: "Growzar takes the courier's answer, through Courierify.",
        affects: `${n(f.total)} orders`,
        link: { to: `/orders?${period}&disagree=1`, label: "See orders" },
      };
    case "stockout":
      return {
        headline: stockoutHeadline(f),
        figure: f.situation === "out" ? "Out" : `${n(f.daysOfCover)} days`,
        note: `left, with a ${n(f.leadTimeDays)}-day lead time and nothing on order`,
        next: "Reorder it in Inventorify now, or set its real lead time there.",
        affects: `about ${n(f.unitsShort)} units of demand`,
        link: { to: "/inventory?days=30", label: "See stock" },
      };
    case "stuck_parcels":
      return {
        headline: `${n(f.booked + f.inTransit)} parcels have not moved for days`,
        figure: f.placed ? figure(f.placed) : n(f.booked + f.inTransit),
        note: f.placed
          ? `in ${n(f.booked + f.inTransit)} orders: ${n(f.booked)} booked and never picked up, ${n(f.inTransit)} in transit with no update`
          : `${n(f.booked)} booked and never picked up, ${n(f.inTransit)} in transit with no update`,
        next: f.booked ? "Ask the courier to pick up the booked parcels, or cancel the ones that will not ship." : "Ask the courier where the parcels in transit are.",
        affects: `${n(f.booked + f.inTransit)} orders`,
        link: { to: `/orders?${period}&stuck=1`, label: "See orders" },
      };
    case "returns_not_received":
      return {
        headline: `${n(f.older)} returns not confirmed back after 14 days`,
        figure: f.productCost ? figure(f.productCost) : n(f.orders),
        note: f.productCost ? `of product in ${n(f.orders)} returned orders not marked received in Courierify` : "returned orders not marked received in Courierify",
        next: "Check them against the courier's return slip, and mark the ones that arrived as received in Courierify.",
        affects: `${n(f.orders)} returned orders`,
        link: { to: `/shipping?${period}`, label: "See returns" },
      };
    case "courier_deductions":
      return {
        headline: `${payerName(f.payer)} kept COD its statement does not explain`,
        figure: `−${figure(f.unitemized)}`,
        note: `${pct(f.unitemizedShare)} of the ${figure(f.cod)} COD it collected, on ${n(f.statements)} statement${f.statements === 1 ? "" : "s"}`,
        next: `Ask ${payerName(f.payer)} for a breakdown of the deduction.`,
        affects: `${n(f.statements)} statement${f.statements === 1 ? "" : "s"}`,
        link: { to: `/finance?${period}`, label: "See deductions" },
      };
    case "courierify_stopped":
      return {
        headline: `Orders stopped going through Courierify after ${f.lastParcelDay}`,
        figure: `${n(f.withParcel)} of ${n(f.shipped)}`,
        note: "shipped orders this period were booked through Courierify",
        why: "For the rest there is no courier time, city or fee, so those comparisons stop at that date.",
        affects: `${n(f.shipped - f.withParcel)} shipped orders`,
        link: { to: `/orders?${period}&decidedBy=financify`, label: "See orders" },
      };
  }
}

/** Specific findings ask for something; store-wide ones are context (rankInsights). */
const URGENCY = {
  specific: { label: "Needs action", tone: "bg-coral-100 text-coral-700" },
  context: { label: "Good to know", tone: "bg-field text-gray-600" },
} as const;

function CompactCard({ item, period, onDetails }: { item: InboxItem; period: string; onDetails: () => void }) {
  const { id, insight } = item;
  const f = insight.finding;
  const s = summaryOf(f, period);
  const area = AREAS[f.kind];
  const urgency = URGENCY[insight.rank.group];
  return (
    <article className="flex h-full flex-col rounded-2xl bg-white p-5">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2">
          <span className={`flex h-8 w-8 items-center justify-center rounded-lg ${area.tint}`}>
            <area.Icon className="h-4 w-4" />
          </span>
          <span className="text-sm font-semibold text-gray-500">{area.label}</span>
        </span>
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${urgency.tone}`}>{urgency.label}</span>
      </div>
      <h3 className="mt-3 line-clamp-2 min-h-[2.75rem] font-display text-lg font-bold leading-snug text-gray-900">{s.headline}</h3>
      <p className="mt-2 font-display text-3xl font-bold tabular-nums tracking-tight text-gray-900">{s.figure}</p>
      <p className="mt-0.5 line-clamp-2 text-sm text-gray-500">{s.note}</p>
      <div className={`mt-3 rounded-xl p-3 text-sm ${s.next ? "bg-mint-50" : "bg-field"}`}>
        <p className={`flex items-center gap-1.5 text-xs font-bold ${s.next ? "text-mint-700" : "text-gray-500"}`}>
          <Lightbulb className="h-3.5 w-3.5" /> {s.next ? "Next step" : "Why it matters"}
        </p>
        <p className="mt-1 line-clamp-3 text-gray-800">{s.next ?? s.why}</p>
      </div>
      <p className="mt-3 flex items-center gap-1.5 text-sm text-gray-600">
        <Target className="h-4 w-4 text-gray-400" /> Affects {s.affects}
      </p>
      <div className="mt-auto flex items-center gap-2 pt-4">
        {s.link ? (
          <Link
            to={via(id, s.link.to)}
            className="inline-flex items-center gap-1.5 rounded-full bg-navy px-4 py-2 text-sm font-semibold text-white hover:bg-navy-surface"
          >
            {s.link.label} <ArrowRight className="h-4 w-4 text-mint" />
          </Link>
        ) : null}
        <button
          type="button"
          onClick={onDetails}
          className="rounded-full bg-field px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-100"
        >
          Details
        </button>
      </div>
    </article>
  );
}

/**
 * Findings as a row of compact cards the merchant pages through, rather than
 * a page of long cards to scroll: three across on a wide screen, one on a
 * phone (swipe, or the arrows). Details opens the full card in a dialog,
 * with snooze and dismiss.
 */
function InsightCarousel({ items, period, canManage }: { items: InboxItem[]; period: string; canManage: boolean }) {
  const track = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState(0);
  const [perView, setPerView] = useState(1);
  const [open, setOpen] = useState<InboxItem | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);

  const measure = () => {
    const el = track.current;
    const card = el?.firstElementChild as HTMLElement | null;
    if (!el || !card) return;
    const step = card.offsetWidth + 16;
    setPerView(Math.max(1, Math.round((el.clientWidth + 16) / step)));
    setAt(Math.round(el.scrollLeft / step));
  };
  useEffect(() => {
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [items.length]);
  useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);
  // A snooze or dismiss from Details takes the card out of the list: close it.
  useEffect(() => {
    if (open && !items.some((i) => i.id === open.id)) setOpen(null);
  }, [items, open]);

  const pages = Math.max(1, items.length - perView + 1);
  const go = (to: number) => {
    const el = track.current;
    const card = el?.firstElementChild as HTMLElement | null;
    if (!el || !card) return;
    el.scrollTo({ left: Math.max(0, Math.min(to, pages - 1)) * (card.offsetWidth + 16), behavior: "smooth" });
  };
  const arrow = "flex h-9 w-9 items-center justify-center rounded-full bg-white text-gray-700 hover:bg-gray-100 disabled:opacity-40";

  return (
    <div>
      <div
        ref={track}
        onScroll={measure}
        className="-mx-1 flex snap-x snap-mandatory gap-4 overflow-x-auto scroll-smooth px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {items.map((item) => (
          <div key={item.id} className="w-[85%] flex-none snap-start sm:w-[calc((100%-1rem)/2)] xl:w-[calc((100%-2rem)/3)]">
            <CompactCard item={item} period={period} onDetails={() => setOpen(item)} />
          </div>
        ))}
      </div>
      {pages > 1 ? (
        <div className="mt-3 flex items-center justify-center gap-3">
          <button type="button" aria-label="Previous findings" className={arrow} disabled={at <= 0} onClick={() => go(at - 1)}>
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="flex items-center gap-1.5" aria-hidden="true">
            {Array.from({ length: pages }, (_, i) => (
              <span key={i} className={`h-2 rounded-full transition-all ${i === at ? "w-5 bg-navy" : "w-2 bg-gray-300"}`} />
            ))}
          </span>
          <span className="sr-only" aria-live="polite">
            Showing {at + 1} to {Math.min(at + perView, items.length)} of {items.length}
          </span>
          <button type="button" aria-label="Next findings" className={arrow} disabled={at >= pages - 1} onClick={() => go(at + 1)}>
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      ) : null}

      <dialog
        ref={dialog}
        onClose={() => setOpen(null)}
        onClick={(e) => e.target === dialog.current && setOpen(null)}
        className="w-[min(42rem,calc(100%-2rem))] rounded-2xl bg-transparent p-0 backdrop:bg-navy/60"
      >
        {open ? (
          <div className="relative">
            <button
              type="button"
              aria-label="Close"
              onClick={() => setOpen(null)}
              className="absolute right-4 top-4 z-10 flex h-9 w-9 items-center justify-center rounded-full bg-field text-gray-700 hover:bg-gray-100"
            >
              <X className="h-4 w-4" />
            </button>
            <FullCard item={open} period={period} canManage={canManage} />
          </div>
        ) : null}
      </dialog>
    </div>
  );
}
