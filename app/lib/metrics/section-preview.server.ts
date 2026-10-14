import { prisma } from "../db.server";
import type { Section } from "../permissions";
import { loadStoreFacts } from "./next-app.server";
import { loadCatalog } from "./products.server";
import type { Money } from "./money";

/**
 * A locked section's preview in the store's own numbers (G-GZR6-4,
 * cross-sell kind 3): what Growzar can already see for this section from the
 * apps the store has, beside what connecting the missing app adds. Facts
 * only; nothing here estimates what the app would do.
 */
export type PreviewFact = { label: string; value: string; note?: string };
export type PreviewRow = { name: string; known: string };
export type SectionPreview = {
  facts: PreviewFact[];
  /** A short list of real rows whose missing column the app fills (e.g. best sellers, without stock). */
  rows: PreviewRow[];
  /** The column those rows lack until the app is connected. */
  missingColumn: string | null;
  days: number;
};

const n = (x: number) => x.toLocaleString("en-GB");
const whole = (m: Money) => `${m.currency} ${n(Math.round(Number(m.amount)))}`;

export async function sectionPreview(section: Section, store: { id: string; currency: string | null }, canSeeMoney: boolean): Promise<SectionPreview | null> {
  if (section === "inventory") return inventoryPreview(store.id);
  const facts = await loadStoreFacts(store.id, store.currency);
  if (!facts || facts.delivered.orders + facts.returns.orders === 0) return null;
  const money = (m: Money | null) => (canSeeMoney && m ? ` · ${whole(m)}` : "");
  const decided = facts.delivered.orders + facts.returns.orders;
  const returnRate = decided ? ((100 * facts.returns.orders) / decided).toFixed(1) : null;
  const base = { rows: [], missingColumn: null, days: facts.days };

  switch (section) {
    case "shipping":
      return {
        ...base,
        facts: [
          { label: "Delivered", value: `${n(facts.delivered.orders)} orders${money(facts.delivered.value)}` },
          { label: "Came back", value: `${n(facts.returns.orders)} orders${money(facts.returns.value)}`, note: returnRate ? `${returnRate}% of decided orders` : undefined },
          { label: "Shipped with no courier tracking", value: `${n(facts.untracked.orders)} orders${money(facts.untracked.value)}` },
        ],
      };
    case "finance":
    case "marketing":
      return {
        ...base,
        facts: [
          { label: "Delivered", value: `${n(facts.delivered.orders)} orders${money(facts.delivered.value)}`, note: "Profit after product cost and ad spend unknown" },
          { label: "Came back", value: `${n(facts.returns.orders)} orders${money(facts.returns.value)}` },
        ],
      };
    case "inbox":
      return {
        ...base,
        facts: [
          { label: "Came back", value: `${n(facts.returns.orders)} orders${money(facts.returns.value)}` },
          { label: "Returned without the buyer ever confirming", value: `${n(facts.unconfirmedReturns.orders)} orders${money(facts.unconfirmedReturns.value)}` },
        ],
      };
    default:
      return null;
  }
}

/** Line items that are fees or add-ons rather than products held in stock. */
const NOT_STOCK = /\b(shipping protection|package protection|insurance|tip|gift ?card|cod fee|shipping fee)\b/i;

/** The five best sellers of the last 30 days and their daily rate; stock is what Inventorify adds. */
async function inventoryPreview(storeId: string): Promise<SectionPreview | null> {
  const days = 30;
  const top = await prisma.$queryRaw<Array<{ variant: string; units: number; orders: number }>>`
    SELECT l->>'variantId' AS variant, sum(COALESCE((l->>'quantity')::int, 1))::int AS units, count(DISTINCT g."orderId")::int AS orders
    FROM order_grain g, jsonb_array_elements(g.lines) l
    WHERE g."storeId" = ${storeId} AND g."createdAt" >= ${new Date(Date.now() - days * 86_400_000)} AND l->>'variantId' IS NOT NULL
    GROUP BY 1 ORDER BY 2 DESC LIMIT 15`;
  if (!top.length) return null;
  const catalog = await loadCatalog(storeId, top.map((t) => t.variant));
  // Checkout add-ons are order lines, not stock.
  const stocked = top.filter((t) => !NOT_STOCK.test(catalog.get(t.variant)?.title ?? "")).slice(0, 5);
  if (!stocked.length) return null;
  return {
    facts: [],
    rows: stocked.map((t) => ({
      name: catalog.get(t.variant)?.title ?? `Variant ${t.variant}`,
      known: `${(t.units / days).toFixed(1)} a day · ${n(t.units)} sold in ${days} days`,
    })),
    missingColumn: "Stock left, and the day it runs out",
    days,
  };
}
