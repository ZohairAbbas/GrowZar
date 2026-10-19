import { Form, useNavigation } from "react-router";
import { MessageCircleQuestionMark } from "lucide-react";

import type { Route } from "./+types/settings.ask";
import { prisma } from "~/lib/db.server";
import { readFormData } from "~/lib/form.server";
import { Forbidden, hasPermission, requireSection } from "~/lib/authorize.server";
import { askEnabled, monthOf } from "~/lib/ask/loop.server";
import { ASK_PRIVACY } from "~/lib/ask/privacy";
import { Notice } from "~/components/metrics/Metrics";

export function meta() {
  return [{ title: "Ask · Settings · Growzar" }];
}

/**
 * Settings → Ask (G-GZR10-6): the organization's switch (off by default,
 * owners and admins only), this month's usage against the cap, and what is
 * sent to OpenAI.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const viewer = await requireSection(request, "settings", "view");
  const now = new Date();
  const month = monthOf(now);
  const [canManage, settings, usage, answers] = await Promise.all([
    hasPermission(request, viewer.organizationId, "settings", "manage"),
    prisma.askSettings.findUnique({ where: { organizationId: viewer.organizationId } }),
    prisma.askUsageMonthly.findUnique({ where: { organizationId_month: { organizationId: viewer.organizationId, month } } }),
    prisma.askMessage.groupBy({
      by: ["status", "feedback"],
      where: { role: "assistant", createdAt: { gte: new Date(`${month}-01T00:00:00Z`) }, conversation: { organizationId: viewer.organizationId } },
      _count: { _all: true },
    }),
  ]);
  const count = (f: (g: (typeof answers)[number]) => boolean) => answers.filter(f).reduce((n, g) => n + g._count._all, 0);
  return {
    canManage,
    serverOn: askEnabled(),
    enabled: settings?.enabled ?? false,
    changedAt: settings?.changedAt?.toISOString() ?? null,
    month,
    capMicros: Number(settings?.monthlyCapMicros ?? 5_000_000n),
    usedMicros: Number(usage?.costMicros ?? 0n),
    questions: usage?.questions ?? 0,
    answered: count((g) => g.status === "answered"),
    up: count((g) => g.feedback === "up"),
    down: count((g) => g.feedback === "down"),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const viewer = await requireSection(request, "settings", "view");
  if (!(await hasPermission(request, viewer.organizationId, "settings", "manage"))) {
    throw new Forbidden("Your role does not allow manage on settings.");
  }
  const intent = String((await readFormData(request)).get("intent") ?? "");
  if (intent !== "enable" && intent !== "disable") return { error: "Nothing to do." };
  const enabled = intent === "enable";
  await prisma.askSettings.upsert({
    where: { organizationId: viewer.organizationId },
    create: { organizationId: viewer.organizationId, enabled, changedByUserId: viewer.userId, changedAt: new Date() },
    update: { enabled, changedByUserId: viewer.userId, changedAt: new Date() },
  });
  return { ok: enabled ? "Ask is on for this organization." : "Ask is off for this organization." };
}

const usd = (micros: number) => `$${(micros / 1e6).toFixed(2)}`;

export default function AskSettings({ loaderData, actionData }: Route.ComponentProps) {
  const { canManage, serverOn, enabled, month, capMicros, usedMicros, questions, answered, up, down } = loaderData;
  const busy = useNavigation().state !== "idle";
  const share = capMicros ? Math.min(100, (100 * usedMicros) / capMicros) : 0;
  return (
    <div className="space-y-4">
      <header>
        <h2 className="flex items-center gap-2 font-display text-lg font-bold text-gray-900">
          <MessageCircleQuestionMark className="h-5 w-5 text-accent-600" /> Ask
        </h2>
        <p className="mt-1 text-sm text-gray-600">
          Members ask about their stores in English or Roman Urdu, and get an answer with the table behind it. Every figure comes from Growzar's own numbers; each member sees only their stores, and money only with Finance access.
        </p>
      </header>

      {actionData && "ok" in actionData ? <Notice>{actionData.ok}</Notice> : null}
      {actionData && "error" in actionData ? <Notice tone="warn">{actionData.error}</Notice> : null}
      {!serverOn ? <Notice tone="warn">Ask is switched off on this server, so nobody can use it whatever the setting below says.</Notice> : null}

      <section className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-white p-5">
        <div>
          <h3 className="font-medium text-gray-900">For this organization</h3>
          <p className="text-sm text-gray-600">{enabled ? "On: members can ask from Home and the Ask page." : "Off: nobody in the organization can ask."}</p>
        </div>
        {canManage ? (
          <Form method="post">
            <button
              type="submit"
              name="intent"
              value={enabled ? "disable" : "enable"}
              disabled={busy}
              className={`inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-semibold disabled:opacity-50 ${enabled ? "bg-field text-gray-700 hover:bg-gray-100" : "bg-navy text-white hover:bg-navy-surface"}`}
            >
              {enabled ? "Turn Ask off" : "Turn Ask on"}
            </button>
          </Form>
        ) : (
          <p className="text-sm text-gray-500">Only an owner or admin can change this.</p>
        )}
      </section>

      <section className="space-y-3 rounded-2xl bg-white p-5">
        <h3 className="font-medium text-gray-900">This month ({month})</h3>
        <div>
          <div className="flex justify-between text-sm text-gray-700">
            <span>{usd(usedMicros)} of {usd(capMicros)} used</span>
            <span>{questions.toLocaleString("en-US")} question(s)</span>
          </div>
          <div className="mt-1.5 h-2 rounded-full bg-field" role="meter" aria-valuemin={0} aria-valuemax={capMicros} aria-valuenow={usedMicros} aria-label="Usage against this month's limit">
            <div className={`h-2 rounded-full ${share >= 100 ? "bg-coral-700" : "bg-data-700"}`} style={{ width: `${Math.max(share, usedMicros ? 1 : 0)}%` }} />
          </div>
          <p className="mt-1.5 text-xs text-gray-500">
            {share >= 100 ? "The limit is reached: questions are paused until the 1st." : "When the limit is reached, questions pause until the 1st of next month."}
          </p>
        </div>
        <p className="text-sm text-gray-600">
          {answered.toLocaleString("en-US")} answered · {up} 👍 · {down} 👎
        </p>
      </section>

      <section className="space-y-2 rounded-2xl bg-white p-5 text-sm text-gray-700">
        <h3 className="font-medium text-gray-900">What is sent to OpenAI</h3>
        {ASK_PRIVACY.long.map((p, i) => (
          <p key={i}>{p}</p>
        ))}
      </section>
    </div>
  );
}
