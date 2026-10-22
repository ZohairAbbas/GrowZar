import { Form, Link } from "react-router";
import { ArrowRight } from "lucide-react";

import { Notice } from "~/components/metrics/Metrics";
import type { CashForecast } from "~/lib/forecast/cash";
import type { HistoryRow } from "~/lib/forecast/cash-history";
import type { MonthEnd } from "~/lib/forecast/month-end";
import type { FormOptions } from "~/lib/forecast/plan.server";
import type { Plan, PlanLine } from "~/lib/forecast/simulator/types";
import type { WhatIf } from "~/lib/forecast/simulator/whatif";
import type { Range } from "~/lib/forecast/stats";

/**
 * Plan's screens (G-GZR11-6, pack §5.6). Every figure shows its range and
 * what it rests on; money only reaches these components for a viewer with
 * finance:view (the loader strips it otherwise).
 */

const n = (x: number) => Math.round(x).toLocaleString("en-US");
const money = (x: number, currency: string) => `${currency} ${n(x)}`;
const rangeText = (r: Range, f: (x: number) => string = n) => (Math.round(r.low) === Math.round(r.high) ? f(r.likely) : `${f(r.low)} – ${f(r.high)}`);
const date = (d: string | null) => (d ? new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }) : "—");

/** Low and high as a thin bar, the likely figure as a tick; the numbers sit beside it in text. */
function RangeBar({ r, max }: { r: Range; max: number }) {
  if (max <= 0) return null;
  const at = (x: number) => `${Math.max(0, Math.min(100, (100 * x) / max))}%`;
  return (
    <div className="relative h-2 w-full rounded-full bg-gray-100" title={`low ${n(r.low)} · likely ${n(r.likely)} · high ${n(r.high)}`}>
      <div className="absolute inset-y-0 rounded-full bg-data" style={{ left: at(r.low), width: `calc(${at(r.high)} - ${at(r.low)})`, minWidth: "4px" }} />
      <div className="absolute -inset-y-0.5 w-0.5 rounded-full bg-navy" style={{ left: at(r.likely) }} />
    </div>
  );
}

function Status({ passes, note, internal }: { passes: boolean; note: string; internal: boolean }) {
  if (!internal) return null;
  return <p className={`rounded-xl px-3 py-2 text-xs ${passes ? "bg-mint-50 text-mint-700" : "bg-coral-50 text-coral-700"}`}>{passes ? "Passes its backtest. " : "Fails its backtest: not shown to merchants. "}{note}</p>;
}

function Card({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className="space-y-3 rounded-2xl bg-white p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-display text-lg font-bold text-gray-900">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

// ── Cash forecast ───────────────────────────────────────────────────────────

export function CashForecastCard({ cash, status, internal }: { cash: CashForecast; status: { passes: boolean; note: string }; internal: boolean }) {
  const c = cash.currency ?? "";
  const max = Math.max(...cash.due.weeks.map((w) => w.high), ...cash.paid.weeks.map((w) => w.high), 1);
  return (
    <Card title="Cash coming back" aside={<span className="text-xs text-gray-500">Next 4 weeks, low – high</span>}>
      <Status {...status} internal={internal} />
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="text-left text-xs font-semibold text-gray-500">
            <tr>
              <th className="py-2 pr-4">Week</th>
              <th className="py-2 pr-4">COD becoming due (delivered)</th>
              <th className="w-1/4 py-2 pr-4" aria-hidden />
              <th className="py-2 pr-4">Paid out (measured or your lag)</th>
              <th className="w-1/4 py-2" aria-hidden />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {cash.weeks.map((w, i) => (
              <tr key={w.from}>
                <td className="whitespace-nowrap py-2 pr-4 text-gray-700">{date(w.from)} – {date(w.to)}</td>
                <td className="whitespace-nowrap py-2 pr-4 tabular-nums text-gray-900">{rangeText(cash.due.weeks[i]!, (x) => money(x, c))}</td>
                <td className="py-2 pr-4"><RangeBar r={cash.due.weeks[i]!} max={max} /></td>
                <td className="whitespace-nowrap py-2 pr-4 tabular-nums text-gray-900">{cash.paid.byPayer.length ? rangeText(cash.paid.weeks[i]!, (x) => money(x, c)) : "—"}</td>
                <td className="py-2">{cash.paid.byPayer.length ? <RangeBar r={cash.paid.weeks[i]!} max={max} /> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {cash.untimed.length ? (
        <div className="text-sm text-gray-700">
          <p className="font-semibold">Payout timing unknown</p>
          <ul className="mt-1 space-y-1">
            {cash.untimed.map((u) => (
              <li key={u.payer}>
                <span className="font-medium">{u.payer}</span>: holds {money(u.deliveredUnpaid, c)} delivered and unpaid ({u.deliveredParcels} parcels); {rangeText(u.expected, (x) => money(x, c))} more delivered in the next 4 weeks.{" "}
                <span className="text-gray-500">{u.reason}.</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {cash.overdue.length ? <p className="text-sm text-coral-700">Older than any payout these couriers have made: {cash.overdue.map((o) => `${o.payer} ${money(o.amount, c)} (${o.parcels} parcels)`).join(", ")}.</p> : null}
      {cash.notTracked.orders ? (
        <p className="text-sm text-gray-600">
          {cash.notTracked.orders} open orders have no Courierify parcel to time: about {rangeText(cash.notTracked.expected, (x) => money(x, c))} of COD, week unknown.
        </p>
      ) : null}
    </Card>
  );
}

// ── Earlier forecasts against what happened (D-94) ───────────────────────────

const inside = (r: Range, x: number) => x >= r.low - 0.5 && x <= r.high + 0.5;

export function CashHistoryCard({ rows, currency }: { rows: HistoryRow[]; currency: string }) {
  const c = currency;
  const anyBank = rows.some((r) => r.bank);
  return (
    <Card title="Earlier forecasts against what happened" aside={<span className="text-xs text-gray-500">Each week as forecast at its start</span>}>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="text-left text-xs font-semibold text-gray-500">
            <tr>
              <th className="py-2 pr-4">Week</th>
              <th className="py-2 pr-4">COD due: forecast</th>
              <th className="py-2 pr-4">Delivered</th>
              <th className="py-2 pr-4">Paid out: forecast</th>
              <th className="py-2 pr-4">Paid by courier</th>
              {anyBank ? <th className="py-2">Received in bank</th> : null}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.map((r) => (
              <tr key={r.from}>
                <td className="whitespace-nowrap py-2 pr-4 text-gray-700">{date(r.from)} – {date(r.to)}</td>
                <td className="whitespace-nowrap py-2 pr-4 tabular-nums text-gray-700">{rangeText(r.due, (x) => money(x, c))}</td>
                <td className={`whitespace-nowrap py-2 pr-4 tabular-nums ${inside(r.due, r.dueActual) ? "text-gray-900" : "text-coral-700"}`}>{money(r.dueActual, c)}</td>
                <td className="whitespace-nowrap py-2 pr-4 tabular-nums text-gray-700">{r.paid ? rangeText(r.paid, (x) => money(x, c)) : "—"}</td>
                <td className={`whitespace-nowrap py-2 pr-4 tabular-nums ${r.paid && r.paidActual !== null && !inside(r.paid, r.paidActual) ? "text-coral-700" : "text-gray-900"}`}>{r.paidActual !== null ? money(r.paidActual, c) : "—"}</td>
                {anyBank ? (
                  <td className="whitespace-nowrap py-2 tabular-nums text-gray-900">
                    {r.bank ? (
                      <>
                        {money(r.bank.received, c)} <span className="text-xs text-gray-500">({r.bank.inBank} of {r.bank.payouts} payouts)</span>
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-gray-500">
        Delivered and paid by courier count only the orders each forecast was made from, read from today's data; red is outside the forecast's range. Paid out is forecast only for couriers whose payout cycle was measured then.
        {anyBank ? " Received in bank is the courier payouts dated that week that your bank statements in Books show, after the couriers' charges." : ""}
      </p>
    </Card>
  );
}

// ── Month end ───────────────────────────────────────────────────────────────

export function MonthEndCard({ month, canSeeMoney, status, internal }: { month: { current: MonthEnd; previous: MonthEnd }; canSeeMoney: boolean; status: { passes: boolean; note: string }; internal: boolean }) {
  const { current: m, previous: p } = month;
  const c = m.currency ?? "";
  const label = (x: string) => new Date(`${x}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "long", timeZone: "UTC" });
  const rows: Array<[string, Range | null, Range | null, (x: number) => string]> = [
    ["Orders", m.orders.total, p.orders.total, n],
    ...(canSeeMoney
      ? ([
          ["Delivered revenue", m.deliveredRevenue, p.deliveredRevenue, (x: number) => money(x, c)],
          ["Profit", m.profit, p.profit, (x: number) => money(x, c)],
        ] as Array<[string, Range | null, Range | null, (x: number) => string]>)
      : []),
  ];
  return (
    <Card title={`${label(m.month)} so far, and where it is heading`} aside={<span className="text-xs text-gray-500">Day {m.daysElapsed} of {m.daysInMonth}</span>}>
      <Status {...status} internal={internal} />
      <table className="min-w-full text-sm">
        <thead className="text-left text-xs font-semibold text-gray-500">
          <tr>
            <th className="py-2 pr-4" />
            <th className="py-2 pr-4">{label(m.month)} at month end (low – high)</th>
            <th className="py-2">{label(p.month)}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map(([name, a, b, f]) => (
            <tr key={name}>
              <td className="py-2 pr-4 font-medium text-gray-700">{name}</td>
              <td className="py-2 pr-4 tabular-nums text-gray-900">{a ? <>{f(a.likely)} <span className="text-gray-500">({rangeText(a, f)})</span></> : "—"}</td>
              <td className="py-2 tabular-nums text-gray-700">{b ? f(b.likely) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs text-gray-500">
        {m.orders.soFar} orders so far; the rest from your last 8 weeks' same-weekday orders{m.trend !== 1 ? `, adjusted ${m.trend > 1 ? "up" : "down"} ${Math.round(Math.abs(m.trend - 1) * 100)}% for the last 4 weeks` : ""}.
        {m.unresolvedAtMonthEnd !== null ? ` About ${Math.round(m.unresolvedAtMonthEnd * 100)}% of the month's orders will still be undecided on its last day.` : ""}
        {canSeeMoney && m.adSpend ? ` Ad spend at this month's rate: ${money(m.adSpend.projected, c)}.` : ""}
      </p>
      {m.notes.length ? <p className="text-xs text-coral-700">{m.notes.join(". ")}.</p> : null}
    </Card>
  );
}

// ── Simulator ───────────────────────────────────────────────────────────────

export function PlanForm({ options, error, busy }: { options: FormOptions; error: string | null; busy: boolean }) {
  const c = options.currency;
  const field = "w-full rounded-xl border border-gray-200 px-3 py-2 text-sm";
  return (
    <Form method="post" className="space-y-4">
      <input type="hidden" name="intent" value="run" />
      {error ? <Notice tone="warn">{error}</Notice> : null}
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="text-sm font-medium text-gray-700">
          Budget ({c})
          <input name="budget" inputMode="numeric" required placeholder={c === "AED" ? "5,000" : "100,000"} className={`mt-1 ${field}`} />
        </label>
        <label className="text-sm font-medium text-gray-700">
          Over how many days
          <input name="horizon" inputMode="numeric" defaultValue={30} className={`mt-1 ${field}`} />
        </label>
        <label className="text-sm font-medium text-gray-700">
          Never keep less than ({c}, optional)
          <input name="minBuffer" inputMode="numeric" placeholder="0" className={`mt-1 ${field}`} />
        </label>
      </div>
      <fieldset className="flex flex-wrap gap-4 text-sm text-gray-700">
        <legend className="mb-1 text-sm font-medium text-gray-700">Where it may go</legend>
        {(["ads", "stock", "buffer"] as const).map((k) => (
          <label key={k} className="inline-flex items-center gap-2">
            <input type="checkbox" name={k} defaultChecked={k !== "stock" || options.hasStock} disabled={k === "stock" && !options.hasStock} />
            {k === "ads" ? "Ad spend" : k === "stock" ? `Stock${options.hasStock ? "" : " (needs Inventorify)"}` : "A cash buffer"}
          </label>
        ))}
      </fieldset>
      {options.platforms.length ? (
        <fieldset className="flex flex-wrap gap-4 text-sm text-gray-700">
          <legend className="mb-1 text-sm font-medium text-gray-700">Leave out these platforms</legend>
          {options.platforms.map((p) => (
            <label key={p} className="inline-flex items-center gap-2 capitalize">
              <input type="checkbox" name="exclude" value={p} /> {p}
            </label>
          ))}
        </fieldset>
      ) : null}
      {options.lags.length ? (
        <fieldset className="space-y-2 text-sm text-gray-700">
          <legend className="mb-1 text-sm font-medium text-gray-700">How many days does each take to pay you after delivery?</legend>
          <p className="text-xs text-gray-500">Growzar can't measure these yet; the plan's cash dates use your numbers and say so.</p>
          {options.lags.map((l) => (
            <label key={l.payer} className="flex flex-wrap items-center gap-3">
              <span className="w-72">{l.payer} <span className="text-gray-500">({Math.round(l.share * 100)}% of your COD)</span></span>
              <input name={`lag:${l.payer}`} inputMode="numeric" required defaultValue={l.last ?? ""} className="w-24 rounded-xl border border-gray-200 px-3 py-1.5" /> days
            </label>
          ))}
        </fieldset>
      ) : null}
      {options.products.length ? (
        <details className="text-sm text-gray-700">
          <summary className="cursor-pointer font-medium">Products to keep in stock, and lead times</summary>
          <table className="mt-2 min-w-full text-sm">
            <thead className="text-left text-xs font-semibold text-gray-500">
              <tr>
                <th className="py-1 pr-3">Keep</th>
                <th className="py-1 pr-3">Product</th>
                <th className="py-1 pr-3">Days of stock</th>
                <th className="py-1">Lead time (days)</th>
              </tr>
            </thead>
            <tbody>
              {options.products.map((p) => (
                <tr key={p.variantId}>
                  <td className="py-1 pr-3"><input type="checkbox" name="keep" value={p.variantId} /></td>
                  <td className="py-1 pr-3">{p.title}</td>
                  <td className="py-1 pr-3 tabular-nums">{p.cover ?? "—"}</td>
                  <td className="py-1">
                    <input name={`lead:${p.variantId}`} inputMode="numeric" defaultValue={p.lead ?? ""} className="w-20 rounded-lg border border-gray-200 px-2 py-1" />{" "}
                    <span className="text-xs text-gray-500">{p.leadSource === "measured" ? "measured" : p.leadSource === "setting" ? "Inventorify setting" : ""}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ) : null}
      <button type="submit" disabled={busy} className="rounded-full bg-navy px-5 py-2.5 text-sm font-bold text-white hover:bg-navy-surface disabled:opacity-60">
        {busy ? "Working it out…" : "Make a plan"}
      </button>
    </Form>
  );
}

const KIND_LABEL: Record<PlanLine["kind"], string> = { buffer: "Buffer", campaign: "Campaign", platform_group: "Platform", stock: "Stock" };

export function PlanResult({ plan, canSeeMoney }: { plan: Plan & { createdAt?: string }; canSeeMoney: boolean }) {
  if (plan.status === "refused") {
    return (
      <div className="space-y-3">
        <Notice tone="warn">Growzar won't make a plan for this store yet: the numbers it would rest on aren't there. Fix these and try again.</Notice>
        <ul className="space-y-2">
          {plan.fixes.map((f, i) => (
            <li key={i} className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-field px-4 py-3 text-sm text-gray-800">
              <span className="flex-1">{f.detail}</span>
              {f.action ? (
                <a href={f.action.href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-full bg-white px-3 py-1.5 font-semibold text-gray-800 hover:bg-gray-100">
                  {f.action.label} <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                </a>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    );
  }
  const c = plan.currency;
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        {canSeeMoney ? (
          <div className="rounded-2xl bg-navy p-4 text-white">
            <p className="text-xs text-navy-muted">Delivered profit after spend, at least</p>
            <p className="font-display text-2xl font-bold tabular-nums">{money(plan.totals.profit.low, c)}</p>
            <p className="text-xs text-navy-muted">likely {money(plan.totals.profit.likely, c)}, up to {money(plan.totals.profit.high, c)}</p>
          </div>
        ) : null}
        <div className="rounded-2xl bg-field p-4">
          <p className="text-xs text-gray-500">Delivered orders from ads</p>
          <p className="font-display text-2xl font-bold tabular-nums text-gray-900">{n(plan.totals.deliveredOrders.likely)}</p>
          <p className="text-xs text-gray-500">{rangeText(plan.totals.deliveredOrders)}</p>
        </div>
        <div className="rounded-2xl bg-field p-4">
          <p className="text-xs text-gray-500">Cash back by</p>
          <p className="font-display text-2xl font-bold text-gray-900">{date(plan.totals.cashBackBy)}</p>
          {canSeeMoney && plan.totals.kept > 0 ? <p className="text-xs text-gray-500">{money(plan.totals.kept, c)} kept as cash</p> : null}
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="border-b border-gray-100 text-left text-xs font-semibold text-gray-500">
            <tr>
              <th className="py-2 pr-4">Line</th>
              {canSeeMoney ? <th className="py-2 pr-4 text-right">Amount</th> : null}
              <th className="py-2 pr-4">Delivered orders</th>
              {canSeeMoney ? <th className="py-2 pr-4">Profit (low – high)</th> : null}
              <th className="py-2">Cash back by</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {plan.lines.map((l) => (
              <tr key={l.key} className="align-top">
                <td className="py-3 pr-4">
                  <p className="font-medium text-gray-900"><span className="mr-2 rounded-full bg-field px-2 py-0.5 text-[11px] font-semibold text-gray-600">{KIND_LABEL[l.kind]}</span>{l.label}</p>
                  {canSeeMoney && l.buys ? <p className="mt-0.5 text-xs text-gray-500">{l.buys}</p> : null}
                  {l.kind !== "stock" && l.products.some((p) => p.share >= 0.01) ? <p className="mt-0.5 text-xs text-gray-500">Sells: {l.products.filter((p) => p.share >= 0.01).slice(0, 3).map((p) => `${p.title} (${Math.round(p.share * 100)}%)`).join(", ")}</p> : null}
                  {l.notes.map((t) => <p key={t} className="mt-0.5 text-xs text-coral-700">{t}</p>)}
                </td>
                {canSeeMoney ? <td className="py-3 pr-4 text-right tabular-nums">{money(l.amount, c)}</td> : null}
                <td className="py-3 pr-4 tabular-nums">{l.deliveredOrders ? `${n(l.deliveredOrders.likely)} (${rangeText(l.deliveredOrders)})` : "—"}</td>
                {canSeeMoney ? (
                  <td className="py-3 pr-4 tabular-nums">
                    {l.kind === "buffer" ? "—" : l.kind === "stock" && l.profit.high === 0 ? <span className="text-xs text-gray-500">in the ad lines</span> : `${n(l.profit.likely)} (${rangeText(l.profit)})`}
                  </td>
                ) : null}
                <td className="py-3 whitespace-nowrap">{date(l.cashBackBy)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {plan.assumptions.length ? (
        <details className="text-sm text-gray-700" open>
          <summary className="cursor-pointer font-semibold">What this rests on</summary>
          <ul className="mt-1 list-disc space-y-1 pl-5">{plan.assumptions.map((a) => <li key={a}>{a}</li>)}</ul>
        </details>
      ) : null}
      {plan.leftOut.length ? (
        <details className="text-sm text-gray-700">
          <summary className="cursor-pointer font-semibold">Left out, and why ({plan.leftOut.length})</summary>
          <ul className="mt-1 list-disc space-y-1 pl-5">{plan.leftOut.map((a) => <li key={a}>{a}</li>)}</ul>
        </details>
      ) : null}
    </div>
  );
}

export function WhatIfs({ planId, options, result, canSeeMoney, currency }: { planId: string; options: FormOptions; result: WhatIf | null; canSeeMoney: boolean; currency: string }) {
  const select = "rounded-xl border border-gray-200 px-2 py-1.5 text-sm";
  const cities = options.cities.map((c) => <option key={c} value={c}>{c}</option>);
  const couriers = options.couriers.map((c) => <option key={c} value={c}>{c}</option>);
  return (
    <div className="space-y-3">
      <h3 className="font-semibold text-gray-900">What if…</h3>
      <Form method="get" className="flex flex-wrap items-center gap-2 text-sm text-gray-700">
        <input type="hidden" name="id" value={planId} />
        <input type="hidden" name="whatif" value="switch" />
        I ship to <select name="city" className={select}>{cities}</select> with <select name="to" defaultValue={options.couriers[1]} className={select}>{couriers}</select> instead of{" "}
        <select name="from" defaultValue={options.couriers[0]} className={select}>{couriers}</select>
        <button className="rounded-full bg-field px-3 py-1.5 font-semibold hover:bg-gray-100">Show</button>
      </Form>
      <Form method="get" className="flex flex-wrap items-center gap-2 text-sm text-gray-700">
        <input type="hidden" name="id" value={planId} />
        <input type="hidden" name="whatif" value="advance" />
        I ask for advance payment in <select name="city" className={select}>{cities}</select>, losing <input name="loss" defaultValue={35} inputMode="numeric" className="w-16 rounded-xl border border-gray-200 px-2 py-1.5" />% of its orders
        <button className="rounded-full bg-field px-3 py-1.5 font-semibold hover:bg-gray-100">Show</button>
      </Form>
      {result ? (
        result.status === "refused" ? (
          <Notice>Can't say: {result.reason}.</Notice>
        ) : (
          <div className="rounded-xl bg-field p-4 text-sm text-gray-800">
            <p>
              Delivered orders {result.deliveredOrders.likely >= 0 ? "+" : ""}{n(result.deliveredOrders.likely)} ({rangeText(result.deliveredOrders)})
              {canSeeMoney ? <>; profit {result.profit.likely >= 0 ? "+" : ""}{money(result.profit.likely, currency)} ({rangeText(result.profit, (x) => money(x, currency))})</> : null}.
            </p>
            <ul className="mt-1 list-disc pl-5 text-xs text-gray-600">{result.basis.map((b) => <li key={b}>{b}</li>)}</ul>
          </div>
        )
      ) : null}
    </div>
  );
}

export function SavedPlans({ plans, current }: { plans: Array<{ id: string; createdAt: string; status: string; budget: number | null }>; current: string | null }) {
  if (!plans.length) return null;
  return (
    <div className="flex flex-wrap gap-2 text-sm">
      {plans.map((p) => (
        <Link key={p.id} to={`/plan?id=${p.id}`} aria-current={p.id === current ? "true" : undefined} className={`rounded-full px-3 py-1.5 ${p.id === current ? "bg-navy text-white" : "bg-white text-gray-700 hover:bg-gray-100"}`}>
          {new Date(p.createdAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
          {p.budget ? ` · ${n(p.budget)}` : ""}
          {p.status === "refused" ? " · refused" : ""}
        </Link>
      ))}
    </div>
  );
}
