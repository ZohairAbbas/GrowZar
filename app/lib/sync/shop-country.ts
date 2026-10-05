/**
 * Which app's `shopCountry` Growzar keeps for a store (hotfix, 2026-10-05).
 *
 * The country is used for one thing: parsing a locally written buyer phone
 * (rule #19). Apps disagree about what "the shop's country" is. Courierify
 * sends Shopify's billing country; Financify (G-FIN2-5) sends the store
 * address. For 0dscam-qn those are PK and GB: the business sells in PKR, on
 * Karachi time, to buyers in Pakistan, from a UK-registered store address.
 * Taking whichever feed synced last made the store flip PK/GB every cycle,
 * and a "0300…" number parsed against GB is a different buyer.
 *
 * So: Courierify's report wins whenever Courierify is connected; another
 * app's report is used only for a store without Courierify. Financify's
 * per-order `buyer.phone.e164` is parsed against each order's own address,
 * and is preferred over any store-level guess where it exists.
 */
export function acceptReportedCountry(app: string, courierifyConnected: boolean): boolean {
  return app === "COURIERIFY" || !courierifyConnected;
}
