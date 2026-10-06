import { Link } from "react-router";
import { ArrowRight } from "lucide-react";

import type { FinanceDepth } from "~/lib/metrics/screens.server";
import { STUCK_DAYS } from "~/lib/metrics/cash";
import { formatAmount } from "./Metrics";
import { scopeLabel } from "./FilterBar";

/**
 * Finance depth (Phase 4c, A1, A3, A4). Bars are one hue for money kept and
 * coral for money lost; every value is printed beside its bar, so colour
 * never carries a number on its own.
 */

const whole = (amount: string) => formatAmount(amount).replace(/\.\d+$/, "");
const signed = (amount: string) =>
  Number(amount) === 0 ? "0" : amount.startsWith("-") ? `−${whole(amount.slice(1).replace(/^-/, ""))}` : whole(amount);

export function MoneyBreakdown({ lines, days, scope }: { lines: FinanceDepth["breakdown"]; days: number; scope: string }) {
  const net = lines.find((l) => l.key === "net");
  const top = Math.max(1, ...lines.map((l) => Math.abs(Number(l.amount.amount))));
  const link: Record<string, string> = { open: "in_transit", returned: "returned", cancelled: "order_cancelled", unknown: "unknown" };
  return (
    <div className="rounded-2xl bg-white p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-display text-lg font-bold text-gray-900">Where the money went</h2>
        <span className="text-xs text-gray-500">{net ? `${net.amount.currency} · share of net order value` : ""}</span>
      </div>
      <table className="mt-3 w-full text-sm">
        <tbody>
          {lines.map((l) => {
            const v = Number(l.amount.amount);
            const loss = v < 0;
            const profitLine = l.key === "profit";
            return (
              <tr key={l.key} className={l.subtotal ? "border-t border-gray-100" : undefined}>
                <td className={`py-1.5 pr-4 ${l.subtotal ? "font-semibold text-gray-900" : "pl-3 text-gray-700"}`}>
                  {link[l.key] && l.orders ? (
                    <Link to={`/orders?days=${days}&outcome=${link[l.key]}${scope ? `&${scope}` : ""}`} className="hover:underline">
                      {l.label}
                    </Link>
                  ) : (
                    l.label
                  )}
                  {l.orders !== undefined && !l.subtotal ? <span className="ml-1 text-xs text-gray-500">{l.orders.toLocaleString()} orders</span> : null}
                </td>
                <td className="hidden w-2/5 py-1.5 pr-4 sm:table-cell">
                  <span className="block h-2 rounded-sm bg-field">
                    <span
                      className={`block h-2 rounded-sm ${profitLine ? (loss ? "bg-coral-600" : "bg-mint-600") : loss ? "bg-coral-200" : "bg-data-700"}`}
                      style={{ width: `${Math.max(1, (100 * Math.abs(v)) / top)}%` }}
                    />
                  </span>
                </td>
                <td className={`py-1.5 pr-4 text-right tabular-nums ${l.subtotal ? "font-semibold" : ""} ${profitLine && loss ? "text-coral-700" : "text-gray-900"}`}>
                  {signed(l.amount.amount)}
                </td>
                <td className="w-16 py-1.5 text-right tabular-nums text-gray-500">{l.share === null ? "" : `${l.share.toFixed(1)}%`}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-3 text-xs text-gray-500">
        Each subtotal is the lines above it. Courier fees are what Courierify recorded on shipped parcels; returned orders
        earn nothing and their product comes back.
      </p>
    </div>
  );
}

export function CashTimelineCard({ cash, days, scope }: { cash: FinanceDepth["cash"]; days: number; scope: string }) {
  const q = (extra: string) => `/orders?days=${days}&${extra}${scope ? `&${scope}` : ""}`;
  const to: Record<string, string> = {
    not_dispatched: q("outcome=not_shipped"),
    booked: q("outcome=booked"),
    with_courier: q("outcome=in_transit"),
    returned: q("outcome=returned"),
    unknown: q("outcome=unknown"),
  };
  const tone: Record<string, string> = {
    paid: "bg-mint-600",
    awaiting: "bg-mint",
    untracked: "bg-mint-200",
    returned: "bg-coral",
  };
  const total = cash.stages.reduce((n, s) => n + s.orders, 0) || 1;
  const stuck = cash.stuck.booked + cash.stuck.inTransit;
  return (
    <div className="rounded-2xl bg-white p-5">
      <h2 className="font-display text-lg font-bold text-gray-900">Where the cash is</h2>
      <p className="mt-1 text-sm text-gray-600">This period&apos;s orders by where their money is today.</p>
      <div className="mt-4 flex h-3 w-full gap-[2px] overflow-hidden rounded-sm" aria-hidden="true">
        {cash.stages.map((s) => (
          <span key={s.key} className={tone[s.key] ?? "bg-data-700/40"} style={{ width: `${(100 * s.orders) / total}%` }} />
        ))}
      </div>
      <dl className="mt-4 grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
        {cash.stages.map((s) => (
          <div key={s.key}>
            <dt className="flex items-center gap-1.5 text-xs font-semibold text-gray-600">
              <span className={`inline-block h-2 w-2 rounded-full ${tone[s.key] ?? "bg-data-700/40"}`} aria-hidden="true" />
              {to[s.key] ? (
                <Link to={to[s.key]!} className="hover:underline">
                  {s.label}
                </Link>
              ) : (
                s.label
              )}
            </dt>
            <dd className="mt-0.5 font-semibold tabular-nums text-gray-900">
              {whole(s.amount.amount)} <span className="text-xs font-normal text-gray-500">{s.amount.currency}</span>
            </dd>
            <dd className="text-xs text-gray-500">{s.orders.toLocaleString()} orders</dd>
          </div>
        ))}
      </dl>
      {stuck ? (
        <Link
          to={q("stuck=1")}
          className="mt-4 flex items-center justify-between gap-3 rounded-xl bg-coral-50 px-4 py-3 text-sm text-coral-700 hover:bg-coral-100"
        >
          <span>
            <span className="font-semibold">
              {stuck.toLocaleString()} parcels stuck, {whole(cash.stuck.amount.amount)} {cash.stuck.amount.currency}:
            </span>{" "}
            {cash.stuck.booked ? `${cash.stuck.booked} booked and not picked up for ${STUCK_DAYS.booked}+ days` : ""}
            {cash.stuck.booked && cash.stuck.inTransit ? ", " : ""}
            {cash.stuck.inTransit ? `${cash.stuck.inTransit} in transit with no courier update for ${STUCK_DAYS.in_transit}+ days` : ""}
          </span>
          <ArrowRight className="h-4 w-4 flex-shrink-0" />
        </Link>
      ) : null}
    </div>
  );
}

export function CourierDeductions({ rows, sources }: { rows: FinanceDepth["deductions"]; sources: Record<string, number> }) {
  if (!rows.length) return null;
  const anyReturnFees = rows.some((r) => r.returnFees);
  const cols: Array<{ label: string; cell: (r: (typeof rows)[number]) => string }> = [
    { label: "COD collected", cell: (r) => whole(r.cod.amount) },
    { label: "COD fee", cell: (r) => signed(`-${r.codFees.amount}`) },
    { label: "Delivery fees", cell: (r) => signed(`-${r.deliveryFees.amount}`) },
    ...(anyReturnFees ? [{ label: "Return fees", cell: (r: (typeof rows)[number]) => (r.returnFees ? signed(`-${r.returnFees.amount}`) : "in delivery fees") }] : []),
    { label: "Tax withheld", cell: (r) => signed(`-${r.tax.amount}`) },
    { label: "Other", cell: (r) => (Number(r.other.amount) ? signed(`-${r.other.amount}`) : "") },
    ...(rows.some((r) => Number(r.unitemized.amount) !== 0)
      ? [{ label: "Not itemized", cell: (r: (typeof rows)[number]) => (Number(r.unitemized.amount) ? signed(`-${r.unitemized.amount}`) : "") }]
      : []),
    { label: "Net paid", cell: (r) => whole(r.netPaid.amount) },
  ];
  return (
    <div className="overflow-x-auto rounded-2xl bg-white p-5">
      <h2 className="font-display text-lg font-bold text-gray-900">What couriers deducted</h2>
      <p className="mt-1 text-sm text-gray-600">
        Courier statements dated in this period, from Courierify: COD collected, what each courier took, and what it paid.
      </p>
      <table className="mt-4 min-w-full text-sm">
        <thead className="border-b border-gray-100 text-left text-xs font-semibold text-gray-500">
          <tr>
            <th className="py-2 pr-4">Courier</th>
            {cols.map((c) => (
              <th key={c.label} className="py-2 pr-4 text-right">{c.label}</th>
            ))}
            <th className="py-2 text-right">Kept</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((r) => (
            <tr key={r.payer}>
              <td className="py-2 pr-4 font-medium text-gray-900">
                {scopeLabel(r.payer)}
                <span className="block text-xs font-normal text-gray-500">
                  {r.statements} {r.statements === 1 ? "statement" : "statements"} · {r.shipments.toLocaleString()} parcels
                  {r.open ? ` · ${r.open} not yet received` : ""}
                </span>
              </td>
              {cols.map((c) => (
                <td key={c.label} className="py-2 pr-4 text-right tabular-nums text-gray-900">{c.cell(r)}</td>
              ))}
              <td className="py-2 text-right font-semibold tabular-nums text-gray-900">{r.keptShare === null ? "" : `${r.keptShare.toFixed(1)}%`}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-3 text-xs text-gray-500">
        Kept is (COD − net paid) ÷ COD. Not itemized is what the statement deducts without naming it. Sources:{" "}
        {Object.entries(sources)
          .map(([s, n]) => `${n} ${s === "courier_api" ? "from the courier's API" : s === "csv_import" ? "imported from a statement file" : s}`)
          .join(", ")}
        .
      </p>
    </div>
  );
}
