import { matchesFilter, type FindingsInput } from "../metrics/findings";
import { isPositive } from "../metrics/money";
import type { Insight } from "../insights/detectors";
import type { WatchItem } from "./watch";

/**
 * The orders a state-based finding is about right now (G-GZR9-1). Cash owed,
 * stuck parcels, returns not back and orders waiting unconfirmed keep no
 * history in Growzar, so a watch can only follow them if it knows which
 * orders they were when the finding was judged. Selected the way each card's
 * own list selects them; null for detectors measured from order history.
 */
export function itemsOf(i: Insight, input: FindingsInput): WatchItem[] | null {
  const f = i.finding;
  const asOf = input.asOf ?? new Date();
  switch (f.kind) {
    case "cash_held":
      return (input.cash?.awaiting ?? [])
        .filter((o) => isPositive(o.uncollected) && matchesFilter(o, f.filter, input.currency, { payers: input.cash!.payers, asOf }))
        .map((o) => ({ orderId: o.orderId, money: o.uncollected! }));
    case "stuck_parcels":
      return input.rows.filter((o) => matchesFilter(o, { kind: "stuck" }, input.currency, { asOf })).map((o) => ({ orderId: o.orderId }));
    case "unconfirmed_returns":
      return input.rows.filter((o) => matchesFilter(o, { kind: "unanswered_waiting" }, input.currency, { asOf })).map((o) => ({ orderId: o.orderId }));
    case "returns_not_received": {
      // As returnsView counts them: returned through Courierify, a parcel not confirmed back.
      const notBack = new Set((input.parcels ?? []).filter((p) => p.outcome === "returned" && !p.returnReceived).map((p) => p.orderId));
      return input.rows
        .filter((o) => o.outcome === "returned" && o.parcelCount > 0 && (o.placed?.currency ?? input.currency) === input.currency && notBack.has(o.orderId))
        .map((o) => ({ orderId: o.orderId }));
    }
    default:
      return null;
  }
}
