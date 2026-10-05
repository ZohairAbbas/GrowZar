import type { Route } from "./+types/settings.profit";
import { prisma } from "~/lib/db.server";
import { listVisibleStores, requireSection } from "~/lib/authorize.server";
import { compareSettings } from "~/lib/metrics/profit-settings";
import { Notice } from "~/components/metrics/Metrics";

export function meta() {
  return [{ title: "Profit settings · Growzar" }];
}

/**
 * Each store's Financify profit settings (rule #15, G-GZR2-5).
 *
 * Five hidden per-store settings change what Financify's "net profit"
 * means, so a roll-up across stores depends on them. This page shows them,
 * says which differ between stores, and says which stores' are unknown.
 * Read-only: they are changed in Financify.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const viewer = await requireSection(request, "settings", "view");
  const stores = await listVisibleStores(viewer);
  const rows = await prisma.storeProfitSettings.findMany({ where: { storeId: { in: stores.map((s) => s.id) } } });
  const byStore = new Map(rows.map((r) => [r.storeId, r]));

  const settings = stores.map((s) => {
    const row = byStore.get(s.id);
    return {
      storeId: s.id,
      shopDomain: s.shopDomain,
      name: s.displayName ?? s.shopDomain,
      settingsHash: row?.settingsHash ?? null,
      settings: (row?.settings as Record<string, { key?: string; value?: unknown }> | undefined) ?? null,
      isDefault: (row?.isDefault as Record<string, boolean> | undefined) ?? null,
      fetchedAt: row?.fetchedAt.toISOString() ?? null,
    };
  });
  return { settings, comparison: compareSettings(settings) };
}

const LABELS: Record<string, string> = {
  costBasis: "Per-order costs counted on",
  feeBasis: "Payment fees charged on",
  taxes: "Taxes included in profit",
  realizedVsExpected: "Profit shown as",
  roasBasis: "ROAS / CPA revenue basis",
};

export default function ProfitSettings({ loaderData }: Route.ComponentProps) {
  const { settings, comparison } = loaderData;
  const differing = new Set(comparison.differences.map((d) => d.setting));
  return (
    <div className="space-y-4">
      <header>
        <h2 className="font-display text-lg font-bold text-gray-900">Profit settings</h2>
        <p className="mt-1 text-sm text-gray-600">
          Financify's net profit depends on five settings per store. Growzar's own “profit after returns” uses one fixed
          definition; these explain why Financify's figure can differ, and whether stores can be compared.
        </p>
      </header>

      {!comparison.consistent ? (
        <Notice tone="warn">
          Your stores use different settings for {comparison.differences.map((d) => LABELS[d.setting] ?? d.setting).join(", ")}.
          Financify's net profit is not comparable across them, and Growzar flags any total that adds them.
        </Notice>
      ) : null}
      {comparison.unknown.length ? (
        <Notice>Not known for {comparison.unknown.join(", ")}: Financify is not connected there.</Notice>
      ) : null}

      {settings.map((s) => (
        <section key={s.storeId} className="rounded-2xl bg-white p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="font-medium text-gray-900">{s.name}</h3>
            <span className="text-xs text-gray-500">
              {s.fetchedAt ? `read from Financify ${new Date(s.fetchedAt).toLocaleString("en-GB")}` : "no Financify"}
            </span>
          </div>
          {s.settings ? (
            <dl className="mt-3 divide-y divide-gray-100 text-sm">
              {Object.entries(s.settings).map(([name, setting]) => (
                <div key={name} className="flex justify-between gap-4 py-2">
                  <dt className="text-gray-600">{LABELS[name] ?? name}</dt>
                  <dd className={differing.has(name) ? "font-medium text-amber-700" : "text-gray-900"}>
                    {String(setting?.value ?? "—")}
                    {s.isDefault && setting?.key && s.isDefault[setting.key] ? (
                      <span className="ml-1 text-xs text-gray-400">(default)</span>
                    ) : null}
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="mt-2 text-sm text-gray-500">Settings unknown.</p>
          )}
        </section>
      ))}
    </div>
  );
}
