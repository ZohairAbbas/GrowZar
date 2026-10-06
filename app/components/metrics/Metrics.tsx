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
        : timing?.basis === "reported_by_3pl"
          ? `${label}, reported by the 3PL on ${day(timing.at)}`
          : timing
          ? `${label}, status as of ${day(timing.at)}`
          : label}
      {authority !== "none" ? (
        <span className="ml-1 text-xs text-gray-400">({authority === "courierify" ? "Courierify" : "Financify"})</span>
      ) : null}
    </span>
  );
}

export function Stat({
  label,
  children,
  note,
  change,
  trend,
}: {
  label: string;
  children: ReactNode;
  note?: ReactNode;
  /** The comparison with the previous period (D2). */
  change?: ReactNode;
  trend?: ReactNode;
}) {
  return (
    <div className="flex flex-col rounded-2xl bg-white p-5">
      <p className="text-sm font-semibold text-gray-700">{label}</p>
      <div className="mt-2 font-display text-2xl font-bold text-gray-900">{children}</div>
      {change ? <div className="mt-1">{change}</div> : null}
      {trend ? <div className="mt-2">{trend}</div> : null}
      {note ? <p className="mt-auto pt-2 text-xs text-gray-500">{note}</p> : null}
    </div>
  );
}

type FxRateView = { from: string; to: string; day: string; rate: string };
type FxReportView = {
  base: string;
  ratesFrom: string | null;
  converted: Array<{ currency: string; orders: number; placed: Money; rates: FxRateView[] }>;
  unconverted: Array<{ currency: string; orders: number; placed: Money; days: string[] }>;
};

const shortDay = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const dayRange = (days: string[]) => (days.length === 1 ? shortDay(days[0]!) : `${shortDay(days[0]!)}–${shortDay(days.at(-1)!)}`);

/** Every figure in the store's currency leads; other currencies are listed after it, never first. */
export function baseFirst(values: Money[], base: string | null): Money[] {
  return [...values].sort((a, b) => (a.currency === base ? -1 : b.currency === base ? 1 : a.currency.localeCompare(b.currency)));
}

/**
 * What happened to orders in another currency (rule #4): which were
 * converted, at which rate, and which could not be, and why. Shown wherever
 * a total includes them.
 */
export function FxNotice({ fx }: { fx: FxReportView | null }) {
  if (!fx || (!fx.converted.length && !fx.unconverted.length)) return null;
  return (
    <Notice tone={fx.unconverted.length ? "warn" : "info"}>
      <ul className="space-y-1">
        {fx.converted.map((c) => (
          <li key={`c-${c.currency}`}>
            {c.orders.toLocaleString()} order{c.orders === 1 ? "" : "s"} in {c.currency} ({formatAmount(c.placed.amount)} {c.currency}) converted to{" "}
            {fx.base} at each order day&apos;s rate from Financify
            {c.rates.length === 1
              ? ` (1 ${c.currency} = ${c.rates[0]!.rate} ${fx.base} on ${shortDay(c.rates[0]!.day)})`
              : ` (${c.rates.length} daily rates, ${dayRange(c.rates.map((r) => r.day))})`}
            .
          </li>
        ))}
        {fx.unconverted.map((u) => (
          <li key={`u-${u.currency}`}>
            <strong>
              {formatAmount(u.placed.amount)} {u.currency}
            </strong>{" "}
            in {u.orders.toLocaleString()} order{u.orders === 1 ? "" : "s"} placed {dayRange(u.days)} is not converted: there is no{" "}
            {u.currency} rate for {u.days.length === 1 ? "that day" : "those days"}
            {fx.ratesFrom ? ` (Financify's daily rates start on ${shortDay(fx.ratesFrom)})` : " (no rates stored yet)"}. It is shown
            separately, never added in.
          </li>
        ))}
      </ul>
    </Notice>
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

/**
 * The one line at the top of a section (D1): which sources behind its
 * numbers are incomplete, and a link to the page that says why. The body of
 * a screen carries no hedges of its own; this replaces them.
 */
export function CoverageLine({ gaps, days }: { gaps: Array<{ key: string; text: string }>; days: number }) {
  const link = (
    <Link to={`/settings/coverage?days=${days}`} className="font-semibold text-accent-600 hover:underline">
      {gaps.length ? "What's missing" : "Data coverage"}
    </Link>
  );
  if (!gaps.length) {
    return (
      <p className="text-xs text-gray-500">
        Every source behind these numbers is complete for this period. {link}
      </p>
    );
  }
  return (
    <p className="text-xs text-gray-600">
      <span className="font-semibold text-gray-700">Based on </span>
      {gaps.map((g) => g.text).join(" · ")}. {link}
    </p>
  );
}

// ── Comparisons and trends (D2) ─────────────────────────────────────────────

type Delta = {
  current: number | null;
  previous: number | null;
  change: number | null;
  direction: "up" | "down" | "flat" | null;
  unit: "percent" | "points";
  notComparable?: string;
};
type Trend = { unit: "day" | "week"; points: Array<{ label: string; value: number | null }> };
/** `neutral`: a move either way is neither good nor bad (campaign spend, say). */
export type HeadlineView = { delta: Delta; trend: Trend | null; good: "up" | "down" | "neutral" };

const compact = (n: number) =>
  Math.abs(n) >= 1_000_000
    ? `${(n / 1_000_000).toFixed(2)}M`
    : Math.abs(n) >= 10_000
      ? `${Math.round(n / 1000).toLocaleString("en-US")}k`
      : Math.round(n).toLocaleString("en-US");

/**
 * The change against the previous period: arrow, size, and what it was.
 * Coloured by whether the move is good for the merchant, not by its sign.
 * `kind` says how to print the previous value.
 */
export function Change({
  h,
  kind = "count",
  dark = false,
}: {
  h: HeadlineView;
  kind?: "count" | "money" | "rate";
  dark?: boolean;
}) {
  const d = h.delta;
  if (d.previous === null) return null;
  const was = kind === "rate" ? `${d.previous.toFixed(1)}%` : compact(d.previous);
  if (d.change === null || d.direction === null) {
    return (
      <span className={`text-xs ${dark ? "text-navy-muted" : "text-gray-500"}`} title={d.notComparable}>
        previous period {was}
        {d.notComparable ? " · not like-for-like" : ""}
      </span>
    );
  }
  const better = d.direction === "flat" || h.good === "neutral" ? null : d.direction === h.good;
  const tone =
    better === null
      ? dark ? "text-navy-muted" : "text-gray-500"
      : better
        ? dark ? "text-mint" : "text-mint-700"
        : dark ? "text-coral" : "text-coral-700";
  const arrow = d.direction === "up" ? "▲" : d.direction === "down" ? "▼" : "▬";
  const size = d.unit === "points" ? `${Math.abs(d.change).toFixed(1)} pts` : `${Math.abs(d.change).toFixed(1)}%`;
  return (
    <span className="text-xs">
      <span className={`font-bold ${tone}`}>
        {arrow} {size}
      </span>
      <span className={dark ? "text-navy-muted" : "text-gray-500"}> vs {was}</span>
    </span>
  );
}

/** A small line of the period, oldest first; a missing point is a gap, never a zero. */
export function Sparkline({ trend, className = "text-data-700" }: { trend: Trend | null; className?: string }) {
  if (!trend) return null;
  const values = trend.points.map((p) => p.value).filter((v): v is number => v !== null);
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const w = 120;
  const h = 28;
  const step = w / Math.max(1, trend.points.length - 1);
  const segments: string[][] = [[]];
  trend.points.forEach((p, i) => {
    if (p.value === null) {
      if (segments.at(-1)!.length) segments.push([]);
      return;
    }
    segments.at(-1)!.push(`${(i * step).toFixed(1)},${(h - 2 - ((p.value - min) / span) * (h - 4)).toFixed(1)}`);
  });
  const first = trend.points[0]?.label.slice(0, 10);
  const last = trend.points.at(-1)?.label.slice(-10);
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className={`h-7 w-full ${className}`}
      role="img"
      aria-label={`${trend.unit === "week" ? "Weekly" : "Daily"} trend from ${first} to ${last}, low ${compact(min)}, high ${compact(max)}`}
    >
      {segments.filter((s) => s.length).map((s, i) =>
        s.length === 1 ? (
          <circle key={i} cx={s[0]!.split(",")[0]} cy={s[0]!.split(",")[1]} r="1.5" fill="currentColor" />
        ) : (
          <polyline key={i} points={s.join(" ")} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        ),
      )}
    </svg>
  );
}
