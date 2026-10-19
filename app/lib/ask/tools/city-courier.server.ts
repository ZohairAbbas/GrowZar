import { z } from "zod";

import { MIN_DECIDED_TO_RATE } from "../../metrics/compare";
import { cityCourierMatrix } from "../../metrics/matrices";
import { parseAmount } from "../../metrics/money";
import { byCity } from "../../metrics/rollups";
import { NO_SCOPE } from "../../metrics/scope";
import { labelOf, toMajor } from "../engine";
import { summaryFor } from "../load.server";
import { periodArg, periodOf, resolvePeriod } from "../period.server";
import type { AskContext, AskTool, Cell, Column, ToolResult } from "../types";
import { FORBIDDEN_STORE, gapsFor, limitArg, oneStoreArg, pickOneStore, refusal, screenLink } from "./common.server";

/**
 * Shipping's city × courier matrix as rows: "which courier is best in
 * Lahore?". Cells are the screen's own (`cityCourierMatrix`), with the
 * average courier fee per shipped order beside them for a viewer who may see
 * money.
 */

export const cityCourierSchema = z
  .object({
    store: oneStoreArg,
    period: periodArg.nullable(),
    city: z.string().nullable().describe("One city, as Growzar names it. Null for the busiest cities."),
    courier: z.string().nullable().describe("One courier key. Null for every courier."),
    limit: limitArg,
  })
  .strict();

const SHIPPED = ["delivered", "returned", "partially_delivered", "in_transit"];

export async function runCityCourier(args: z.infer<typeof cityCourierSchema>, ctx: AskContext): Promise<ToolResult> {
  const name = "city_courier";
  const store = pickOneStore(ctx, args.store);
  if (store === "ambiguous") return refusal(name, "invalid", "Which store? Couriers and cities are compared within one store; call list_stores for the ids.");
  if (!store) return refusal(name, "forbidden", FORBIDDEN_STORE);
  const period = resolvePeriod(args.period, store.timezone, ctx.now);
  if ("error" in period) return refusal(name, "invalid", period.error);
  const s = await summaryFor(ctx, store.id, period, NO_SCOPE);
  const money = ctx.can("finance") && s.store.currency !== null;

  const cityKey = args.city ? (s.scopeOptions.cities.find((c) => c.key.toLowerCase() === args.city!.trim().toLowerCase())?.key ?? args.city.trim()) : null;
  const courierKey = args.courier ? (s.scopeOptions.couriers.find((c) => c.key.toLowerCase() === args.courier!.trim().toLowerCase())?.key ?? args.courier.trim()) : null;
  const matrix = cityCourierMatrix(s.rows, cityKey ? [cityKey] : undefined, args.limit ?? 12);

  const rows: Array<Record<string, Cell>> = [];
  for (const c of matrix.cities) {
    for (const courier of matrix.couriers) {
      if (courierKey && courier !== courierKey) continue;
      const cell = c.cells[courier]!;
      if (!cell.orders) continue;
      const row: Record<string, Cell> = {
        city: c.city,
        courier: labelOf("courier", courier, {}),
        courier_key: courier,
        orders: cell.orders,
        decided: cell.decided,
        delivered: cell.delivered,
        delivery_rate: cell.rate,
      };
      if (money) {
        const shipped = s.rows.filter((o) => byCity(o)[0] === c.city && o.courier === courier && SHIPPED.includes(o.outcome));
        const fees = shipped.filter((o) => o.courierFee && o.courierFee.currency === s.store.currency);
        row.avg_fee = fees.length ? toMajor(fees.reduce((a, o) => a + parseAmount(o.courierFee!.amount)!, 0n) / BigInt(fees.length)) : null;
        row.fee_known_on = fees.length;
      }
      rows.push(row);
    }
  }
  // Rated cells first, best rate first, then by volume.
  const rate = (r: Record<string, Cell>) => r.delivery_rate as number | null;
  rows.sort((a, b) => Number(rate(a) === null) - Number(rate(b) === null) || (rate(b) ?? 0) - (rate(a) ?? 0) || (b.orders as number) - (a.orders as number));

  const columns: Column[] = [
    { key: "city", label: "City", kind: "text" },
    { key: "courier", label: "Courier", kind: "text" },
    { key: "courier_key", label: "Courier key", kind: "text" },
    { key: "orders", label: "Orders", kind: "count" },
    { key: "decided", label: "Decided orders", kind: "count" },
    { key: "delivered", label: "Delivered", kind: "count" },
    { key: "delivery_rate", label: "Delivery rate", kind: "percent" },
    ...(money
      ? ([
          { key: "avg_fee", label: "Average courier fee", kind: "money", currency: s.store.currency! },
          { key: "fee_known_on", label: "Shipped orders with a fee", kind: "count", money: true },
        ] satisfies Column[])
      : []),
  ];
  const thin = rows.filter((r) => r.delivery_rate === null).length;
  return {
    tool: name,
    status: rows.length ? (rows.some((r) => r.delivery_rate !== null) ? "ok" : "not_enough_data") : "no_data",
    title: cityKey ? `Couriers in ${cityKey}` : "Delivery rate by city and courier",
    columns,
    rows,
    meta: {
      period: periodOf(period),
      stores: [{ id: store.id, name: store.name }],
      currency: money ? s.store.currency : undefined,
      rules: [
        `Delivery rate = delivered ÷ (delivered + returned), by order; a cell under ${MIN_DECIDED_TO_RATE} decided orders keeps its counts and has no rate.`,
        "Only orders booked with a courier have one; cities are Courierify's canonical names (rule #12).",
        ...(money ? ["Average courier fee = recorded fees ÷ shipped orders with a fee recorded."] : []),
      ],
      gaps: await gapsFor(ctx, s, "shipping"),
      notes: [
        ...(thin ? [`${thin} city–courier pair(s) have under ${MIN_DECIDED_TO_RATE} decided orders, so no rate`] : []),
        ...(matrix.moreCities.cities && !cityKey ? [`${matrix.moreCities.cities} quieter cities (${matrix.moreCities.orders} orders) not listed`] : []),
      ],
    },
    link: { href: screenLink("shipping", store, period.query, { city: cityKey, courier: courierKey }), label: "Open Shipping", exact: !cityKey && !courierKey },
  };
}

export const cityCourier: AskTool<typeof cityCourierSchema> = {
  name: "city_courier",
  description: "Delivery rate, volume and (with Finance access) average courier fee for each city and courier pair in one store, e.g. 'which courier is best in Lahore?'. Rates only where a pair has enough decided orders.",
  schema: cityCourierSchema,
  sections: () => ["shipping"],
  run: runCityCourier,
};
