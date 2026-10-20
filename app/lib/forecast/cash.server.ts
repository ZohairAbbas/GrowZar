import { loadForecastBase } from "./base.server";
import { forecastCash, type CashForecast, type CashOptions } from "./cash";

/** The store's cash forecast as its data stood at `asOf` (G-GZR11-2). */
export async function cashForecast(storeId: string, asOf: Date = new Date(), opts: CashOptions = {}): Promise<CashForecast> {
  return forecastCash(await loadForecastBase(storeId, asOf), opts);
}
