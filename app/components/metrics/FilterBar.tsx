import { Form, Link } from "react-router";
import { X } from "lucide-react";

/**
 * One filter bar per section (Phase 4b, D2): store, period, courier and
 * city. Store switches through /switch like the sidebar; the rest are query
 * parameters every loader reads the same way, so a drill-down link and the
 * bar always agree.
 *
 * Courier and city submit on change; the Apply button is the no-script path.
 */
type Option = { key: string; orders: number };

export const courierName = (key: string) => key.replace(/^financify:/, "");
export const scopeLabel = (key: string) => (key === "unknown" ? "No courier" : key === "no city" ? "No city" : key === "unmapped" ? "Unmapped city" : courierName(key));

const shortDay = (d: string) => {
  const m = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(d.slice(5, 7)) - 1];
  return `${Number(d.slice(8, 10))} ${m}`;
};

export function FilterBar({
  section,
  stores,
  days,
  periods,
  previous,
  historyFrom,
  scope,
  options,
  keep,
}: {
  section: string;
  stores: { activeId: string | null; list: Array<{ id: string; name: string }>; returnTo: string };
  days: number;
  periods: readonly number[];
  previous: { from: string; to: string };
  /** Set when the store's history starts after the previous period does. */
  historyFrom: string | null;
  scope: { courier: string | null; city: string | null };
  /** Null on Home, whose insights are store-wide. */
  options: { couriers: Option[]; cities: Option[] } | null;
  /** Other query parameters to carry (a finding filter, an outcome). */
  keep: string;
}) {
  const query = (o: { days?: number; courier?: string | null; city?: string | null }) => {
    const q = new URLSearchParams(keep);
    q.set("days", String(o.days ?? days));
    const courier = o.courier === undefined ? scope.courier : o.courier;
    const city = o.city === undefined ? scope.city : o.city;
    if (courier) q.set("courier", courier);
    if (city) q.set("city", city);
    return `?${q.toString()}`;
  };
  const select = "rounded-full border-0 bg-white py-1.5 pl-3.5 pr-8 text-sm font-semibold text-gray-700 focus:ring-2 focus:ring-mint";

  return (
    <div className="flex flex-wrap items-center gap-2">
      {stores.list.length > 1 ? (
        <Form method="post" action="/switch" className="contents">
          <input type="hidden" name="intent" value="switch-store" />
          <input type="hidden" name="returnTo" value={`${stores.returnTo}?days=${days}`} />
          <label className="sr-only" htmlFor="filter-store">Store</label>
          <select
            id="filter-store"
            name="storeId"
            defaultValue={stores.activeId ?? undefined}
            className={select}
            onChange={(e) => e.currentTarget.form?.requestSubmit()}
          >
            {stores.list.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
          <noscript><button type="submit" className="text-sm font-semibold text-accent-600">Switch</button></noscript>
        </Form>
      ) : null}

      <nav aria-label="Period" className="inline-flex rounded-full bg-white p-1 text-sm font-semibold">
        {periods.map((d) => (
          <Link
            key={d}
            to={query({ days: d })}
            preventScrollReset
            aria-current={d === days ? "page" : undefined}
            className={`rounded-full px-3 py-1 ${d === days ? "bg-navy text-white" : "text-gray-600 hover:text-gray-900"}`}
          >
            {d}d
          </Link>
        ))}
      </nav>

      {options ? (
        <Form method="get" className="contents">
          {[...new URLSearchParams(keep).entries()].map(([k, v]) => (
            <input key={k} type="hidden" name={k} value={v} />
          ))}
          <input type="hidden" name="days" value={days} />
          <label className="sr-only" htmlFor="filter-courier">Courier</label>
          <select id="filter-courier" name="courier" defaultValue={scope.courier ?? ""} className={select} onChange={(e) => e.currentTarget.form?.requestSubmit()}>
            <option value="">All couriers</option>
            {options.couriers.map((c) => (
              <option key={c.key} value={c.key}>{scopeLabel(c.key)} ({c.orders.toLocaleString()})</option>
            ))}
          </select>
          <label className="sr-only" htmlFor="filter-city">City</label>
          <select id="filter-city" name="city" defaultValue={scope.city ?? ""} className={select} onChange={(e) => e.currentTarget.form?.requestSubmit()}>
            <option value="">All cities</option>
            {options.cities.map((c) => (
              <option key={c.key} value={c.key}>{scopeLabel(c.key)} ({c.orders.toLocaleString()})</option>
            ))}
          </select>
          <noscript><button type="submit" className="text-sm font-semibold text-accent-600">Apply</button></noscript>
        </Form>
      ) : null}

      {scope.courier ? (
        <Link to={query({ courier: null })} className="inline-flex items-center gap-1 rounded-full bg-navy px-3 py-1.5 text-xs font-semibold text-white">
          {scopeLabel(scope.courier)} <X className="h-3.5 w-3.5 text-mint" aria-label="Remove courier filter" />
        </Link>
      ) : null}
      {scope.city ? (
        <Link to={query({ city: null })} className="inline-flex items-center gap-1 rounded-full bg-navy px-3 py-1.5 text-xs font-semibold text-white">
          {scopeLabel(scope.city)} <X className="h-3.5 w-3.5 text-mint" aria-label="Remove city filter" />
        </Link>
      ) : null}

      <span className="text-xs text-gray-500">
        {historyFrom
          ? `History starts ${shortDay(historyFrom)}, so there is no full previous ${days} days to compare with`
          : `Compared with ${shortDay(previous.from)}–${shortDay(previous.to)}`}
        {(scope.courier || scope.city) && (section === "finance" || section === "home") ? " · ad spend is store-wide, so it is left out while filtered" : ""}
      </span>
    </div>
  );
}
