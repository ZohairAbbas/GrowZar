import { MIN_ROUTE_Z, zScore } from "./findings";
import { formatAmount, parseAmount, type Money } from "./money";
import { times, type ReturnCost } from "./return-cost";

/**
 * I10, ad spend on buyers who never accept delivery (DECISION-LAYER; G-GZR6-1).
 *
 * A campaign's *new* buyers are the ones it was paid to find: buyers whose
 * first order with the store Financify ties to it (`attribution.campaignKey`).
 * When those first parcels come back far more often than the store's other
 * new buyers' do, the campaign is buying buyers who don't accept delivery.
 *
 * Money is measured, not predicted: the campaign's spend in the period
 * (platform spend plus fees) split evenly over every order Financify ties to
 * it, summed over the first orders that came back; and the courier charges of
 * the returns above the store's rate, at the store's median charge per return
 * (the method I8 and the products card use).
 */

/** Decided first orders a campaign needs before it is judged. */
export const MIN_DECIDED_FIRSTS = 30;
/** Return-rate gap, in points, over the store's other new buyers. */
export const GAP_POINTS = 10;
/** Campaigns named on one card. */
export const MAX_FLAGGED = 3;

export type FirstOrder = { campaignKey: string | null; outcome: string };

export type CampaignAcquisition = {
  key: string;
  name: string | null;
  platform: string | null;
  /** New buyers it brought in the period, and what their first orders did. */
  firsts: number;
  decided: number;
  returned: number;
  rate: number | null;
  /** Every order Financify ties to it in the period (spend is split over these). */
  orders: number;
  /** Platform spend plus fees in the period; null when it is not known for every day. */
  spend: Money | null;
  /** The share of that spend that went on first orders that came back. */
  spendOnReturned: Money | null;
};

export type AcquisitionView = {
  /** All the store's new buyers in the period with a known outcome. */
  store: { decided: number; returned: number; rate: number | null };
  campaigns: CampaignAcquisition[];
};

const decidedOutcome = (o: string) => o === "delivered" || o === "returned";
/** Money is held in millionths; a split is shown to the paisa. */
const CENT = 10_000n;
const toCents = (units: bigint) => ((units + CENT / 2n) / CENT) * CENT;
const pct = (n: number, d: number) => (d ? Math.round((1000 * n) / d) / 10 : null);

export function acquisitionView(input: {
  firsts: readonly FirstOrder[];
  ordersByCampaign: ReadonlyMap<string, number>;
  spend: ReadonlyMap<string, Money> | null;
  names: ReadonlyMap<string, { name: string | null; platform: string | null }>;
}): AcquisitionView {
  const by = new Map<string, { firsts: number; decided: number; returned: number }>();
  let decided = 0;
  let returned = 0;
  for (const f of input.firsts) {
    const isDecided = decidedOutcome(f.outcome);
    if (isDecided) decided += 1;
    if (f.outcome === "returned") returned += 1;
    if (!f.campaignKey) continue;
    const c = by.get(f.campaignKey) ?? { firsts: 0, decided: 0, returned: 0 };
    c.firsts += 1;
    if (isDecided) c.decided += 1;
    if (f.outcome === "returned") c.returned += 1;
    by.set(f.campaignKey, c);
  }
  const campaigns = [...by.entries()].map(([key, c]): CampaignAcquisition => {
    const orders = Math.max(input.ordersByCampaign.get(key) ?? 0, c.firsts);
    // No spend recorded (e.g. a platform Financify doesn't import) is unknown, not free.
    const recorded = input.spend?.get(key) ?? null;
    const spend = recorded && (parseAmount(recorded.amount) ?? 0n) > 0n ? recorded : null;
    const units = spend ? parseAmount(spend.amount) : null;
    return {
      key,
      name: input.names.get(key)?.name ?? null,
      platform: input.names.get(key)?.platform ?? (key.includes(":") ? key.split(":")[0]! : null),
      ...c,
      rate: pct(c.returned, c.decided),
      orders,
      spend,
      spendOnReturned: spend && units !== null && orders ? { amount: formatAmount(toCents((units * BigInt(c.returned)) / BigInt(orders))), currency: spend.currency } : null,
    };
  });
  return { store: { decided, returned, rate: pct(returned, decided) }, campaigns: campaigns.sort((a, b) => b.firsts - a.firsts || a.key.localeCompare(b.key)) };
}

export type FlaggedCampaign = CampaignAcquisition & {
  /** The store's other new buyers, for comparison. */
  restRate: number;
  z: number;
  /** First orders that came back above the rest's rate. */
  excessReturns: number;
  /** Their courier charges at the store's median charge per return. */
  returnCharges: Money | null;
};

export type CampaignReturnsFinding = {
  kind: "campaign_returns";
  storeRate: number;
  flagged: FlaggedCampaign[];
  /** Spend on returned first orders, over the flagged campaigns whose spend is known. */
  spendOnReturned: Money | null;
  /** How many of the flagged campaigns that total covers. */
  spendKnownFor: number;
};

type Skip = { kind: "skip"; status: "not_enough_data" | "nothing_found"; reason: string };

/** I10: campaigns whose new buyers send their first parcel back far more often than the store's other new buyers. */
export function campaignReturnsFinding(v: AcquisitionView | null | undefined, returnCost?: ReturnCost | null): CampaignReturnsFinding | Skip {
  if (!v || !v.campaigns.length) return { kind: "skip", status: "not_enough_data", reason: "No first order in this period is tied to a campaign" };
  const judged = v.campaigns.filter((c) => c.decided >= MIN_DECIDED_FIRSTS);
  if (!judged.length) {
    return { kind: "skip", status: "not_enough_data", reason: `No campaign has ${MIN_DECIDED_FIRSTS} delivered or returned first orders in this period` };
  }
  const flagged: FlaggedCampaign[] = [];
  for (const c of judged) {
    const restDecided = v.store.decided - c.decided;
    const restReturned = v.store.returned - c.returned;
    if (restDecided < MIN_DECIDED_FIRSTS) continue;
    const rate = (100 * c.returned) / c.decided;
    const restRate = (100 * restReturned) / restDecided;
    const z = zScore(c.returned, c.decided, restReturned, restDecided);
    if (rate - restRate < GAP_POINTS || z < MIN_ROUTE_Z) continue;
    const excessReturns = Math.max(0, c.returned - Math.round((c.decided * restRate) / 100));
    flagged.push({
      ...c,
      restRate: Math.round(restRate * 10) / 10,
      z: Math.round(z * 100) / 100,
      excessReturns,
      returnCharges: returnCost && excessReturns ? times(returnCost.perReturn, excessReturns) : null,
    });
  }
  if (!flagged.length) {
    return { kind: "skip", status: "nothing_found", reason: `None of ${judged.length} campaign(s) with ${MIN_DECIDED_FIRSTS}+ decided first orders brings buyers who return ${GAP_POINTS}+ points more than the store's other new buyers` };
  }
  const shown = flagged.sort((a, b) => b.excessReturns - a.excessReturns || a.key.localeCompare(b.key)).slice(0, MAX_FLAGGED);
  const spends = shown.map((c) => c.spendOnReturned).filter((s): s is Money => s !== null);
  const currency = spends[0]?.currency;
  const oneCurrency = !!currency && spends.every((s) => s.currency === currency);
  return {
    kind: "campaign_returns",
    storeRate: v.store.rate ?? 0,
    flagged: shown,
    spendOnReturned: oneCurrency ? { amount: formatAmount(spends.reduce((t, s) => t + parseAmount(s.amount)!, 0n)), currency } : null,
    spendKnownFor: oneCurrency ? spends.length : 0,
  };
}
