import { MoneyList } from "./Metrics";

/** Abandoned checkouts in Marketing (G-GZR5-6). Computed on the server in `metrics/checkouts.ts`. */

type Money = { amount: string; currency: string };
export type CheckoutsPanelView = {
  started: number;
  abandoned: number;
  abandonedValue: Money[];
  open: number;
  settled: number;
  followedUp: number;
  notFollowedUp: number;
  notFollowedUpValue: Money[];
  recovered: number;
  recoveredValue: Money[];
  cameBack: number;
  cartJourneys: Array<{ name: string; status: string | null; lastSent: string | null }>;
};

const n = (x: number) => x.toLocaleString("en-GB");
const shortDate = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

function Figure({ label, value, money }: { label: string; value: number; money?: Money[] }) {
  return (
    <div className="rounded-xl bg-field p-3">
      <p className="text-xs font-semibold text-gray-500">{label}</p>
      <p className="mt-1 font-display text-xl font-bold tabular-nums text-gray-900">{n(value)}</p>
      {money?.length ? <p className="text-xs text-gray-600"><MoneyList values={money} /></p> : null}
    </div>
  );
}

export function CheckoutsPanel({
  view,
  canSeeMoney,
  source = "shopify_checkout",
  retainifyConnected = true,
}: {
  view: CheckoutsPanelView;
  canSeeMoney: boolean;
  source?: "shopify_checkout" | "cod_form";
  retainifyConnected?: boolean;
}) {
  const m = (x: Money[]) => (canSeeMoney ? x : undefined);
  const form = source === "cod_form";
  return (
    <div className="rounded-2xl bg-white p-5">
      <h2 className="font-display text-lg font-bold text-gray-900">{form ? "COD-form abandonments" : "Abandoned checkouts"}</h2>
      <p className="mt-1 text-sm text-gray-600">
        {form
          ? `${n(view.started)} buyers left your COD form in this period (Preventify); ${n(view.abandoned)} did not order within the hour.`
          : `${n(view.started)} checkouts started in this period; ${n(view.abandoned)} did not become an order within the hour.`}
        {view.open ? ` ${n(view.open)} of those are still inside their 7 days to come back.` : ""}
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Figure label="Abandoned, 7 days over" value={view.settled} />
        <Figure label="Got no reminder" value={view.notFollowedUp} money={m(view.notFollowedUpValue)} />
        <Figure label="Came back after a reminder" value={view.recovered} money={m(view.recoveredValue)} />
        <Figure label="Came back on their own" value={view.cameBack} />
      </div>
      {form ? (
        <p className="mt-4 text-sm text-gray-700">
          {retainifyConnected
            ? "Reminders are any Retainify message to the same buyer by phone."
            : "Retainify is not connected to this store, so Growzar sees no reminders to these buyers."}
        </p>
      ) : view.cartJourneys.length ? (
        <ul className="mt-4 space-y-1 text-sm text-gray-700">
          {view.cartJourneys.map((j) => (
            <li key={j.name}>
              Retainify cart journey <strong className="text-gray-900">{j.name}</strong>: {j.status ?? "status unknown"}
              {j.lastSent ? `, last sent ${shortDate(j.lastSent)}` : ", never sent"}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 text-sm text-gray-700">Retainify has no journey triggered by an abandoned cart for this store.</p>
      )}
      <ul className="mt-3 list-disc space-y-0.5 pl-5 text-xs text-gray-500">
        <li>
          A reminder is any Retainify message for that checkout, or to the same buyer by email or phone, within 7 days and before an order.
          Messages sent by other apps are not seen.
        </li>
        <li>
          Value is what was in the {form ? "form, from Preventify" : "checkout, from Retainify"}; recovered means a reminder, then an order
          within 7 days (rule #24).
        </li>
      </ul>
    </div>
  );
}
