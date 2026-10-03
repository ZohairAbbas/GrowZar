import type { ReactNode } from "react";
import { Link } from "react-router";
import { AlertTriangle, Info } from "lucide-react";

/**
 * Display pieces for the read-only screens (G-GZR2-5).
 *
 * Several display rules live here rather than in each screen, so no screen
 * can break them by accident:
 *  - money is shown per currency and never added across currencies (rule #4),
 *    and formatted from its decimal string, never through a float;
 *  - a delivery rate is never shown without the count still in transit
 *    (rule #8);
 *  - "delivered on" only with a courier time, otherwise "status as of"
 *    (rule #9).
 *
 * Only types may come from `.server` modules here: anything else drags server
 * code into the client bundle, which broke the Phase 1 production build.
 */

type Money = { amount: string; currency: string };
type DeliveryRate = { rate: number | null; delivered: number; returned: number; stillOpen: number; partial: number };

/** "1234567.5" → "1,234,567.50", without passing through a float. */
export function formatAmount(amount: string): string {
  const negative = amount.startsWith("-");
  const [whole = "0", fraction = ""] = amount.replace("-", "").split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "−" : ""}${grouped}.${fraction.padEnd(2, "0").slice(0, 2)}`;
}

export function MoneyList({ values, empty = "—" }: { values: Money[]; empty?: string }) {
  if (!values.length) return <span className="text-gray-400">{empty}</span>;
  return (
    <span className="inline-flex flex-col">
      {values.map((m) => (
        <span key={m.currency} className="tabular-nums">
          {formatAmount(m.amount)} <span className="text-xs font-semibold opacity-60">{m.currency}</span>
        </span>
      ))}
    </span>
  );
}

export function DeliveryRateText({ rate }: { rate: DeliveryRate }) {
  return (
    <span>
      <span className="font-semibold tabular-nums text-gray-900">
        {rate.rate === null ? "No outcomes yet" : `${(100 * rate.rate).toFixed(1)}% delivered`}
      </span>
      <span className="text-gray-500">
        {" "}
        · {rate.stillOpen.toLocaleString()} still in transit
        {rate.partial ? ` · ${rate.partial} partly delivered` : ""}
      </span>
    </span>
  );
}

const OUTCOME_LABEL: Record<string, string> = {
  delivered: "Delivered",
  returned: "Returned",
  partially_delivered: "Partly delivered",
  in_transit: "In transit",
  booked: "Booked",
  shipment_cancelled: "Shipment cancelled",
  order_cancelled: "Order cancelled",
  not_shipped: "Not shipped",
  unknown: "Unknown",
};

export const outcomeLabel = (outcome: string) => OUTCOME_LABEL[outcome] ?? outcome.replace(/_/g, " ");

const day = (iso: string) =>
  new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

export function OutcomeText({
  outcome,
  timing,
  authority,
}: {
  outcome: string;
  timing: { basis: string; at: string } | null;
  authority: string;
}) {
  const label = OUTCOME_LABEL[outcome] ?? outcome;
  return (
    <span>
      {timing?.basis === "happened_on"
        ? `${label} on ${day(timing.at)}`
        : timing
          ? `${label}, status as of ${day(timing.at)}`
          : label}
      {authority !== "none" ? (
        <span className="ml-1 text-xs text-gray-400">({authority === "courierify" ? "Courierify" : "Financify"})</span>
      ) : null}
    </span>
  );
}

export function Stat({ label, children, note }: { label: string; children: ReactNode; note?: ReactNode }) {
  return (
    <div className="rounded-2xl bg-white p-5">
      <p className="text-sm font-semibold text-gray-700">{label}</p>
      <div className="mt-2 font-display text-2xl font-bold text-gray-900">{children}</div>
      {note ? <p className="mt-2 text-xs text-gray-500">{note}</p> : null}
    </div>
  );
}

export function Notice({ tone = "info", children }: { tone?: "info" | "warn"; children: ReactNode }) {
  const warn = tone === "warn";
  const Icon = warn ? AlertTriangle : Info;
  return (
    <div
      className={`flex items-start gap-3 rounded-2xl p-4 text-sm ${
        warn ? "bg-coral-100 text-coral-700" : "bg-white text-gray-700"
      }`}
    >
      <Icon className={`mt-0.5 h-4 w-4 flex-shrink-0 ${warn ? "text-coral-700" : "text-gray-500"}`} />
      <div>{children}</div>
    </div>
  );
}

export function PeriodPicker({ days, options, keep = "" }: { days: number; options: readonly number[]; keep?: string }) {
  return (
    <nav aria-label="Period" className="inline-flex rounded-full bg-white p-1 text-sm font-semibold">
      {options.map((d) => (
        <Link
          key={d}
          to={`?days=${d}${keep ? `&${keep}` : ""}`}
          preventScrollReset
          aria-current={d === days ? "page" : undefined}
          className={`rounded-full px-3.5 py-1.5 ${d === days ? "bg-navy text-white" : "text-gray-600 hover:text-gray-900"}`}
        >
          {d} days
        </Link>
      ))}
    </nav>
  );
}

export function CoverageNotice({ coverage }: { coverage: { shippedOrders: number; withParcel: number; degraded: boolean } }) {
  if (!coverage.degraded) return null;
  return (
    <Notice tone="warn">
      Only {coverage.withParcel.toLocaleString()} of {coverage.shippedOrders.toLocaleString()} shipped orders in this
      period were booked through Courierify. For the rest, delivery status comes from Financify, and there is no
      city, courier delivery time or courier fee.
    </Notice>
  );
}
