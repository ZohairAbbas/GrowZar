/**
 * Which app's `shopCountry` Growzar keeps for a store (hotfix 2026-10-05;
 * ranked 2026-10-09).
 *
 * The country is used for one thing: parsing a locally written buyer phone
 * (rule #19). Apps disagree about what "the shop's country" is:
 *  - Courierify sends Shopify's billing country, and has every parcel's
 *    buyer, so it has been the store's authority since the hotfix;
 *  - Inventorify, Retainify and Preventify (Phase 5) send the primary
 *    location's country, or Preventify the merchant's own country setting;
 *  - Financify (G-FIN2-5) sends the store address, which for 0dscam-qn and
 *    zainvault is the UK registration, not where the buyers are.
 * Taking whichever feed synced last made a store flip PK/GB (0dscam-qn) or
 * AE/GB (zainvault) every cycle, and a "0300…" number parsed against GB is
 * a different buyer.
 *
 * So a report is kept only when no connected app ranks above the reporting
 * one. Apps of equal rank read the same thing from Shopify.
 */
const RANK: Record<string, number> = { COURIERIFY: 0, INVENTORIFY: 1, RETAINIFY: 1, PREVENTIFY: 1, FINANCIFY: 2 };
const rankOf = (app: string) => RANK[app] ?? 3;

export function acceptReportedCountry(app: string, connected: readonly string[]): boolean {
  const mine = rankOf(app);
  return !connected.some((other) => other !== app && rankOf(other) < mine);
}
