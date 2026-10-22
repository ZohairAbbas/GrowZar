import { prisma } from "../db.server";
import type { Viewer } from "../authorize.server";
import { listAccounts, setupBook, type BookView } from "../books/books.server";
import { saveTaxRate } from "../books/taxes.server";
import { suggestedRates } from "../books/tax";
import { todayIn } from "../books/dates";
import { TAX_ACCOUNT_FOR_KIND, fiscalYearStartOn, planStores, sharedTimeZone, type SetupPlan, type SetupStore } from "./setup";

/** Everything the setup screen proposes for an organization (B2). */
export async function setupContext(viewer: Viewer) {
  const [org, stores] = await Promise.all([
    prisma.organization.findUniqueOrThrow({ where: { id: viewer.organizationId }, select: { name: true, baseCurrency: true } }),
    prisma.store.findMany({ where: { organizationId: viewer.organizationId }, orderBy: { shopDomain: "asc" }, select: { id: true, shopDomain: true, displayName: true, currency: true, timezone: true } }),
  ]);
  const setupStores: SetupStore[] = stores.map((s) => ({ id: s.id, name: s.displayName ?? s.shopDomain, currency: s.currency, timezone: s.timezone }));
  const currency = org.baseCurrency.toUpperCase();
  const plan = planStores(setupStores, currency);
  const timeZone = sharedTimeZone(plan.included.length ? plan.included : setupStores);
  const today = todayIn(timeZone ?? "Asia/Karachi");
  const fiscalYearStartMonth = 7;
  return {
    organizationName: org.name,
    currency,
    stores: plan,
    timeZone,
    timeZones: [...new Set(setupStores.map((s) => s.timezone).filter((z): z is string => !!z).concat(timeZone ? [] : ["Asia/Karachi", "Asia/Dubai", "Asia/Riyadh", "UTC"]))],
    today,
    fiscalYearStartMonth,
    startDate: fiscalYearStartOn(today, fiscalYearStartMonth),
    taxRates: suggestedRates(currency).map((r) => ({ name: r.name, kind: r.kind, rate: String(r.rateBp / 100) })),
  };
}

/**
 * Create the book from a checked plan: the chart, money accounts and their
 * opening balances in one transaction (the engine's setupBook), then the tax
 * rates, each on its template account.
 */
export async function createBook(viewer: Viewer, plan: SetupPlan): Promise<BookView> {
  const book = await setupBook(
    viewer.organizationId,
    {
      currency: plan.currency,
      timeZone: plan.timeZone,
      fiscalYearStartMonth: plan.fiscalYearStartMonth,
      startDate: plan.startDate,
      moneyAccounts: plan.moneyAccounts,
      settings: { startDate: plan.startDate, storeIds: plan.storeIds, codBasis: plan.codBasis },
    },
    viewer.userId,
  );
  if (plan.taxRates.length) {
    const accounts = await listAccounts(book);
    const byName = new Map(accounts.map((a) => [a.name, a.id]));
    for (const r of plan.taxRates) {
      await saveTaxRate(book, { name: r.name, kind: r.kind, rateBp: r.rateBp, accountId: byName.get(TAX_ACCOUNT_FOR_KIND[r.kind]) ?? null }, viewer.userId);
    }
  }
  return book;
}
