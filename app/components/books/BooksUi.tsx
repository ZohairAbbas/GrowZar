import type { ReactNode } from "react";
import { NavLink } from "react-router";

import { cn } from "~/lib/utils";
import { useCenterActive } from "~/components/ui/useCenterActive";

/**
 * Small pieces the Books screens share (B2). Plain words on primary screens,
 * every error names its field (Financify's copy rules, porting guide §7).
 */

export const inputClass =
  "block h-11 w-full rounded-xl border border-gray-200 bg-gray-50 px-3.5 text-sm transition focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/20 disabled:bg-gray-100 disabled:text-gray-500";

export const buttonClass =
  "inline-flex h-10 items-center justify-center gap-1.5 rounded-full bg-navy px-5 text-sm font-semibold text-white transition hover:bg-navy-surface disabled:opacity-50";

export const quietButtonClass =
  "inline-flex h-9 items-center justify-center gap-1.5 rounded-full bg-field px-4 text-sm font-semibold text-gray-700 transition hover:bg-gray-100 disabled:opacity-50";

export function Field({ label, htmlFor, help, error, children }: { label: string; htmlFor?: string; help?: ReactNode; error?: string | null; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1.5 block text-sm font-semibold text-gray-700">
        {label}
      </label>
      {children}
      {error ? <p className="mt-1.5 text-xs font-medium text-coral-700">{error}</p> : help ? <p className="mt-1.5 text-xs text-gray-500">{help}</p> : null}
    </div>
  );
}

export function Card({ title, aside, children }: { title?: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-4 rounded-2xl bg-white p-5">
      {title || aside ? (
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          {title ? <h2 className="font-display text-lg font-bold text-gray-900">{title}</h2> : <span />}
          {aside}
        </div>
      ) : null}
      {children}
    </section>
  );
}

const TABS = [
  { to: "/books", label: "Overview", end: true },
  { to: "/books/entries", label: "Entries" },
  { to: "/books/drafts", label: "To approve" },
  { to: "/books/bank", label: "Bank" },
  { to: "/books/couriers", label: "Couriers" },
  { to: "/books/stock", label: "Stock" },
  { to: "/books/reports", label: "Reports" },
  { to: "/books/close", label: "Close" },
  { to: "/books/accounts", label: "Accounts" },
  { to: "/books/opening", label: "Opening balances" },
  { to: "/books/sources", label: "Where entries come from" },
  { to: "/books/activity", label: "Activity" },
];

/** The Books tabs; "To approve" shows how many drafts wait. */
export function BooksTabs({ drafts = 0 }: { drafts?: number }) {
  const strip = useCenterActive<HTMLElement>();
  // One row that scrolls sideways on a phone; eleven tabs would wrap onto four.
  return (
    <nav ref={strip} className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0">
      {TABS.map((t) => (t.to === "/books/drafts" && drafts ? { ...t, label: `To approve · ${drafts}` } : t)).map((t) => (
        <NavLink
          key={t.to}
          to={t.to}
          end={t.end}
          className={({ isActive }) => cn("tap flex-shrink-0 whitespace-nowrap rounded-full px-3.5 py-1.5 text-sm font-semibold transition", isActive ? "bg-navy text-white" : "bg-white text-gray-700 hover:bg-gray-100")}
        >
          {t.label}
        </NavLink>
      ))}
    </nav>
  );
}

/** A money figure, already formatted on the server; a negative in red. */
export function Money({ value, className }: { value: string; className?: string }) {
  return <span className={cn("tabular-nums", value.startsWith("−") || value.startsWith("(") ? "text-coral-700" : null, className)}>{value}</span>;
}
