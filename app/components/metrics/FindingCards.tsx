import type { ReactNode } from "react";
import { Link } from "react-router";
import { ArrowRight } from "lucide-react";

import type {
  CourierifyStoppedFinding,
  DecidedBy,
  DisagreementFinding,
  Finding,
  MarginFinding,
  VariantReturnsFinding,
  VariantRate,
} from "~/lib/metrics/findings";
import { formatAmount, MoneyList, outcomeLabel } from "./Metrics";

/**
 * Home's cross-app findings (G-GZR3-1). Plain cards: what was found, the
 * measured numbers, what the figure leaves out, which app each part came
 * from, and a link to the orders behind it. No recommendations or money
 * estimates yet; those arrive per detector after its backtest.
 */

type Money = { amount: string; currency: string };
const money = (m: Money) => `${formatAmount(m.amount)} ${m.currency}`;
const n = (x: number) => x.toLocaleString("en-GB");

function Card({ title, children, link }: { title: ReactNode; children: ReactNode; link?: { to: string; label: string } }) {
  return (
    <article className="rounded-2xl border border-gray-200 bg-white p-5">
      <h3 className="text-base font-semibold text-gray-900">{title}</h3>
      <div className="mt-2 space-y-2 text-sm text-gray-700">{children}</div>
      {link ? (
        <Link to={link.to} className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-primary-600 hover:underline">
          {link.label} <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      ) : null}
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

function DisagreementCard({ f, days }: { f: DisagreementFinding; days: number }) {
  return (
    <Card
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
            <span className="text-xs text-gray-500">
              placed value <MoneyList values={g.placed} />
            </span>
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

function VariantCard({ f, days }: { f: VariantReturnsFinding; days: number }) {
  return (
    <Card title={`${f.flagged.length === 1 ? "A product comes" : `${f.flagged.length} products come`} back far more often than the rest`}>
      <ul className="space-y-1.5">
        {f.flagged.map((v) => (
          <li key={v.variantId}>
            <span className="font-medium">{v.title ?? `Variant ${v.variantId}`}</span>: {rateLine(v)}{" "}
            <Link to={`/orders?days=${days}&variant=${v.variantId}`} className="whitespace-nowrap text-primary-600 hover:underline">
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

function MarginCard({ f, days }: { f: MarginFinding; days: number }) {
  const negative = f.ceiling.amount.startsWith("-");
  const leaves: ReactNode[] = [
    `Courier fees on ${n(f.feesUnknown.orders)} of ${n(f.feesUnknown.shipped)} shipped orders: not recorded.`,
    "What a return costs (the return fee, goods that cannot be sold again): no app records it.",
  ];
  if (f.cogsIncompleteOrders) leaves.push(`COGS is incomplete on ${n(f.cogsIncompleteOrders)} delivered order(s).`);
  if (f.excludedCurrencies.length) leaves.push(`Orders in ${f.excludedCurrencies.join(", ")} are left out, not converted.`);
  return (
    <Card
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

function CourierifyStoppedCard({ f, days }: { f: CourierifyStoppedFinding; days: number }) {
  return (
    <Card
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

export function FindingCards({ findings, days, from, to }: { findings: Finding[]; days: number; from: string; to: string }) {
  return (
    <section className="space-y-3" aria-labelledby="findings-heading">
      <div>
        <h2 id="findings-heading" className="text-lg font-semibold text-gray-900">
          What Growzar found
        </h2>
        <p className="text-xs text-gray-500">
          {from} to {to}. Measured from your connected apps, each with the orders behind it. Recommendations and
          estimates of what each is worth come once each finding has been checked against past data.
        </p>
      </div>
      {findings.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-gray-300 bg-white p-5 text-sm text-gray-600">
          Nothing in this period passed its checks. Each finding needs enough orders before it says anything; try a
          longer period.
        </p>
      ) : (
        findings.map((f) => {
          switch (f.kind) {
            case "disagreements":
              return <DisagreementCard key={f.kind} f={f} days={days} />;
            case "variant_returns":
              return <VariantCard key={f.kind} f={f} days={days} />;
            case "margin":
              return <MarginCard key={f.kind} f={f} days={days} />;
            case "courierify_stopped":
              return <CourierifyStoppedCard key={f.kind} f={f} days={days} />;
          }
        })
      )}
    </section>
  );
}
