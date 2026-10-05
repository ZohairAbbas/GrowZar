/**
 * Financify's delivery city (G-FIN2-2) in Courierify's city names. Pure.
 *
 * Financify sends the address text as stored ("Karachi City", "karachi");
 * Courierify sends a canonical city from its tehsil mapping. Rule #12 forbids
 * merging spellings by guesswork, so the mapping is learned from the store's
 * own orders that both apps know: a spelling maps to a city only when it was
 * seen at least MIN_VOTES times and agreed at least MIN_SHARE of the time.
 * A spelling that is exactly a known city name maps to it too. Anything else
 * stays "unmapped", as Courierify's own unmatched spellings do.
 */

export const MIN_VOTES = 3;
export const MIN_SHARE = 0.9;

export type CityAlias = { canonical: string; votes: number; of: number; how: "learned" | "name" };

/** Case, spaces and punctuation at the ends do not make a different city. */
export function normalizeCity(raw: string): string {
  return raw.toLowerCase().replace(/\s+/g, " ").replace(/^[\s,.-]+|[\s,.-]+$/g, "");
}

export function learnCityAliases(pairs: ReadonlyArray<{ raw: string; canonical: string }>): Map<string, CityAlias> {
  const votes = new Map<string, Map<string, number>>();
  const canonicals = new Set<string>();
  for (const { raw, canonical } of pairs) {
    const key = normalizeCity(raw);
    if (!key) continue;
    canonicals.add(canonical);
    const v = votes.get(key) ?? new Map<string, number>();
    v.set(canonical, (v.get(canonical) ?? 0) + 1);
    votes.set(key, v);
  }
  const out = new Map<string, CityAlias>();
  for (const name of canonicals) out.set(normalizeCity(name), { canonical: name, votes: 0, of: 0, how: "name" });
  for (const [key, v] of votes) {
    const of = [...v.values()].reduce((a, b) => a + b, 0);
    const [canonical, top] = [...v.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]!;
    if (top >= MIN_VOTES && top / of >= MIN_SHARE) out.set(key, { canonical, votes: top, of, how: "learned" });
    else if (out.get(key)?.how === "name" && out.get(key)!.canonical !== canonical) out.delete(key); // the data disagrees with the name
  }
  return out;
}
