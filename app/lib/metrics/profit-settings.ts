/**
 * Profit settings across stores (rule #15, G-GZR2-4). Pure.
 *
 * Financify's "net profit" depends on five per-store settings. A roll-up
 * across stores whose settings differ is adding two different definitions,
 * so it is flagged — and the flag names *which* settings differ and how,
 * because "hashes differ" tells a merchant nothing they can act on.
 *
 * Growzar's own "profit after returns" has one fixed definition and does not
 * read these settings; it is still shown beside them, because a merchant
 * comparing it with Financify's figure needs to know why they differ.
 */

export type StoreSettings = {
  storeId: string;
  shopDomain: string;
  /** Null when Financify is not connected or has not answered. */
  settingsHash: string | null;
  /** `{ costBasis: { key, value }, … }` as Financify sends it. */
  settings: Record<string, unknown> | null;
};

export type SettingsComparison = {
  /** True when every store with settings has the same hash. */
  consistent: boolean;
  /** Distinct hashes, with the stores on each. */
  groups: Array<{ settingsHash: string; shops: string[] }>;
  /** Each setting whose value differs, with every store's value. */
  differences: Array<{ setting: string; values: Record<string, unknown> }>;
  /** Stores whose settings are unknown (no Financify). */
  unknown: string[];
};

function valueOf(setting: unknown): unknown {
  return setting && typeof setting === "object" && "value" in setting
    ? (setting as { value: unknown }).value
    : setting;
}

export function compareSettings(stores: readonly StoreSettings[]): SettingsComparison {
  const known = stores.filter((s) => s.settingsHash);
  const groups = new Map<string, string[]>();
  for (const s of known) groups.set(s.settingsHash!, [...(groups.get(s.settingsHash!) ?? []), s.shopDomain]);

  const names = new Set(known.flatMap((s) => Object.keys(s.settings ?? {})));
  const differences: SettingsComparison["differences"] = [];
  for (const name of [...names].sort()) {
    const values: Record<string, unknown> = {};
    for (const s of known) values[s.shopDomain] = valueOf(s.settings?.[name]);
    if (new Set(Object.values(values).map((v) => JSON.stringify(v))).size > 1) {
      differences.push({ setting: name, values });
    }
  }

  return {
    consistent: groups.size <= 1,
    groups: [...groups].map(([settingsHash, shops]) => ({ settingsHash, shops })),
    differences,
    unknown: stores.filter((s) => !s.settingsHash).map((s) => s.shopDomain),
  };
}
