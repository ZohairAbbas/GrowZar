import { Form, useNavigation, useSearchParams } from "react-router";
import { Mail, Send } from "lucide-react";

import type { Route } from "./+types/settings.digest";
import { prisma } from "~/lib/db.server";
import { env } from "~/lib/env.server";
import { readFormData } from "~/lib/form.server";
import { Forbidden, hasPermission, requireSection } from "~/lib/authorize.server";
import { buildDigest, digestRecipients, sendTestDigest, storeCache, type Recipient } from "~/lib/digest/digest.server";
import { nextSendDay, SEND_HOUR, weekLabel } from "~/lib/digest/week";
import { Notice } from "~/components/metrics/Metrics";

export function meta() {
  return [{ title: "Weekly digest · Growzar" }];
}

/**
 * The weekly digest (G-GZR6-5, D-57). Everyone can turn their own copy off
 * or on. Owners and admins (settings:manage) also see each member's digest
 * exactly as it would be sent this week, who gets one and why not, the send
 * log, and the switch that turns it on for the organization; and can send
 * any member's digest to themselves as a test.
 */
const status = (r: Recipient) =>
  !r.canHome ? "No Home access" : !r.stores.length ? "No stores" : r.optedOut ? "Opted out" : "Gets it";

export async function loader({ request, url }: Route.LoaderArgs) {
  const viewer = await requireSection(request, "settings", "view");
  const canManage = await hasPermission(request, viewer.organizationId, "settings", "manage");
  const [me, settings, organization] = await Promise.all([
    prisma.member.findUniqueOrThrow({ where: { id: viewer.memberId }, select: { digestOptOut: { select: { via: true, at: true } } } }),
    prisma.digestSettings.findUnique({ where: { organizationId: viewer.organizationId } }),
    prisma.organization.findUniqueOrThrow({ where: { id: viewer.organizationId }, select: { name: true } }),
  ]);
  const base = {
    optedOut: me.digestOptOut !== null,
    enabled: settings?.enabled ?? false,
    sending: env.DIGEST_SENDING === "on",
    canManage,
  };
  if (!canManage) return { ...base, admin: null };

  const now = new Date();
  const recipients = await digestRecipients(viewer.organizationId);
  const selected = recipients.find((r) => r.memberId === url.searchParams.get("member")) ?? recipients.find((r) => r.memberId === viewer.memberId) ?? recipients[0];
  // A viewer scoped to some stores previews only those, whoever the member is.
  const preview =
    selected && selected.canHome && selected.stores.length
      ? await buildDigest(selected, organization.name, now, storeCache(now), { onlyStores: viewer.scopedStoreIds })
      : null;
  const log = await prisma.digestSend.findMany({
    where: { organizationId: viewer.organizationId },
    orderBy: { createdAt: "desc" },
    take: 30,
    select: { id: true, createdAt: true, week: true, mode: true, status: true, email: true, error: true, content: true },
  });
  return {
    ...base,
    admin: {
      selected: selected?.memberId ?? null,
      recipients: recipients.map((r) => ({
        memberId: r.memberId,
        email: r.email,
        name: r.name,
        role: r.role,
        status: status(r),
        money: r.canSeeMoney,
        next: `${weekLabel(nextSendDay(now, r.timezone))}, ${String(SEND_HOUR).padStart(2, "0")}:00 ${r.timezone}`,
      })),
      preview: preview
        ? {
            subject: preview.subject,
            html: preview.html,
            hasContent: preview.hasContent,
            skipped: preview.stores.filter((s) => s.skipped).map((s) => ({ name: s.name, why: s.skipped === "stale" ? "its apps have not synced for 48 hours" : "nothing to report" })),
          }
        : null,
      log: log.map((l) => ({
        id: l.id,
        at: l.createdAt.toISOString(),
        week: l.week,
        mode: l.mode,
        status: l.status,
        email: l.email,
        error: l.error,
        items: Array.isArray(l.content) ? (l.content as Array<{ items?: unknown[] }>).reduce((t, s) => t + (s.items?.length ?? 0), 0) : 0,
      })),
    },
  };
}

export async function action({ request }: Route.ActionArgs) {
  const viewer = await requireSection(request, "settings", "view");
  const form = await readFormData(request);
  const intent = String(form.get("intent") ?? "");

  if (intent === "me-off") {
    await prisma.digestOptOut.upsert({ where: { memberId: viewer.memberId }, create: { memberId: viewer.memberId, via: "settings" }, update: {} });
    return { ok: "You won't get the weekly digest." };
  }
  if (intent === "me-on") {
    await prisma.digestOptOut.deleteMany({ where: { memberId: viewer.memberId } });
    return { ok: "You'll get the weekly digest." };
  }

  if (!(await hasPermission(request, viewer.organizationId, "settings", "manage"))) {
    throw new Forbidden("Your role does not allow manage on settings.");
  }
  if (intent === "enable" || intent === "disable") {
    const enabled = intent === "enable";
    await prisma.digestSettings.upsert({
      where: { organizationId: viewer.organizationId },
      create: { organizationId: viewer.organizationId, enabled, changedByUserId: viewer.userId, changedAt: new Date() },
      update: { enabled, changedByUserId: viewer.userId, changedAt: new Date() },
    });
    return { ok: enabled ? "The weekly digest is on for this organization." : "The weekly digest is off for this organization." };
  }
  if (intent === "test") {
    const recipients = await digestRecipients(viewer.organizationId);
    const target = recipients.find((r) => r.memberId === form.get("member"));
    const me = recipients.find((r) => r.memberId === viewer.memberId);
    if (!target || !me) return { error: "That member is not in this organization." };
    if (!target.canHome || !target.stores.length) return { error: "That member gets no digest, so there is nothing to send." };
    const sent = await sendTestDigest(viewer.organizationId, target, { userId: viewer.userId, memberId: viewer.memberId, email: me.email, scopedStoreIds: viewer.scopedStoreIds });
    return sent.sent
      ? { ok: `Test sent to ${me.email}.` }
      : sent.reason === "empty"
        ? { error: "This member's digest has nothing in it this week, so no test was sent. The preview says why." }
        : { error: sent.reason === "no_api_key" ? "Email is not set up on this server (no Resend key), so nothing was sent." : "The email service refused the test. It is in the log below." };
  }
  return { error: "Nothing to do." };
}

const STATUS_TONE: Record<string, string> = {
  sent: "bg-mint-100 text-mint-700",
  dry_run: "bg-data-100 text-data-700",
  failed: "bg-coral-100 text-coral-700",
  no_api_key: "bg-coral-100 text-coral-700",
};

export default function DigestSettings({ loaderData, actionData }: Route.ComponentProps) {
  const { optedOut, enabled, sending, canManage, admin } = loaderData;
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const [params, setParams] = useSearchParams();
  const button = "inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-semibold disabled:opacity-50";

  return (
    <div className="space-y-4">
      <header>
        <h2 className="font-display text-lg font-bold text-gray-900">Weekly digest</h2>
        <p className="mt-1 text-sm text-gray-600">
          Every Monday at 09:00 in your store's time: each store's top three findings from Home's “Needs your attention”, worded as on Home,
          and its next app. Members who can't see Finance get it without money.
        </p>
      </header>

      {actionData && "ok" in actionData ? <Notice>{actionData.ok}</Notice> : null}
      {actionData && "error" in actionData ? <Notice tone="warn">{actionData.error}</Notice> : null}

      <section className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-white p-5">
        <div>
          <h3 className="font-medium text-gray-900">Your copy</h3>
          <p className="text-sm text-gray-600">
            {optedOut ? "You have turned it off." : enabled ? "You get it every Monday." : "You'll get it once your organization turns it on."}
          </p>
        </div>
        <Form method="post">
          <button
            type="submit"
            name="intent"
            value={optedOut ? "me-on" : "me-off"}
            disabled={busy}
            className={`${button} ${optedOut ? "bg-navy text-white hover:bg-navy-surface" : "bg-field text-gray-700 hover:bg-gray-100"}`}
          >
            <Mail className="h-4 w-4" /> {optedOut ? "Send it to me" : "Stop sending it to me"}
          </button>
        </Form>
      </section>

      {canManage && admin ? (
        <>
          <section className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-white p-5">
            <div>
              <h3 className="font-medium text-gray-900">For the organization</h3>
              <p className="text-sm text-gray-600">
                {!enabled
                  ? "Off. Nothing is built or sent until you turn it on."
                  : sending
                    ? "On. Digests go out every Monday."
                    : "On, as a dry run: each Monday's digests are built and logged below, and not emailed yet."}
              </p>
            </div>
            <Form method="post">
              <button
                type="submit"
                name="intent"
                value={enabled ? "disable" : "enable"}
                disabled={busy}
                className={`${button} ${enabled ? "bg-field text-gray-700 hover:bg-gray-100" : "bg-navy text-white hover:bg-navy-surface"}`}
              >
                {enabled ? "Turn off" : "Turn on"}
              </button>
            </Form>
          </section>

          <section className="rounded-2xl bg-white p-5">
            <h3 className="font-medium text-gray-900">Who gets it</h3>
            <table className="mt-3 w-full text-sm">
              <thead className="text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="py-2">Member</th>
                  <th className="py-2">Status</th>
                  <th className="hidden py-2 md:table-cell">Money</th>
                  <th className="hidden py-2 md:table-cell">Next</th>
                  <th />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {admin.recipients.map((r) => (
                  <tr key={r.memberId} className={r.memberId === admin.selected ? "bg-field" : ""}>
                    <td className="py-2 pr-3">
                      <span className="block font-medium text-gray-900">{r.name || r.email}</span>
                      <span className="text-xs text-gray-500">
                        {r.email} · {r.role}
                      </span>
                    </td>
                    <td className="py-2 pr-3 text-gray-700">{r.status}</td>
                    <td className="hidden py-2 pr-3 text-gray-700 md:table-cell">{r.money ? "Shown" : "Hidden"}</td>
                    <td className="hidden py-2 pr-3 text-gray-500 md:table-cell">{r.status === "Gets it" ? r.next : "—"}</td>
                    <td className="py-2 text-right">
                      <button
                        type="button"
                        onClick={() => {
                          const next = new URLSearchParams(params);
                          next.set("member", r.memberId);
                          setParams(next, { preventScrollReset: true });
                        }}
                        className="font-semibold text-accent-600 hover:underline"
                      >
                        Preview
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="space-y-3 rounded-2xl bg-white p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="font-medium text-gray-900">
                  Preview: {admin.recipients.find((r) => r.memberId === admin.selected)?.email ?? "—"}
                </h3>
                <p className="text-sm text-gray-600">This week's digest for this member, built now, exactly as it would be sent.</p>
              </div>
              {admin.preview?.hasContent ? (
                <Form method="post">
                  <input type="hidden" name="member" value={admin.selected ?? ""} />
                  <button type="submit" name="intent" value="test" disabled={busy} className={`${button} bg-navy text-white hover:bg-navy-surface`}>
                    <Send className="h-4 w-4" /> Send a test to me
                  </button>
                </Form>
              ) : null}
            </div>
            {admin.preview ? (
              <>
                <p className="text-sm text-gray-700">
                  <span className="font-semibold">Subject:</span> {admin.preview.subject}
                </p>
                {admin.preview.skipped.map((s) => (
                  <Notice key={s.name}>
                    {s.name} is left out: {s.why}.
                  </Notice>
                ))}
                {admin.preview.hasContent ? (
                  <iframe title="Digest preview" sandbox="" srcDoc={admin.preview.html} className="h-[720px] w-full rounded-xl border border-gray-100 bg-[#f5f5f5]" />
                ) : (
                  <Notice>Nothing to send this member this week, so no email would go out.</Notice>
                )}
              </>
            ) : (
              <Notice>This member gets no digest: they have no Home access or no stores.</Notice>
            )}
          </section>

          <section className="rounded-2xl bg-white p-5">
            <h3 className="font-medium text-gray-900">Send log</h3>
            {admin.log.length ? (
              <table className="mt-3 w-full text-sm">
                <thead className="text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                  <tr>
                    <th className="py-2">When</th>
                    <th className="py-2">To</th>
                    <th className="py-2">Kind</th>
                    <th className="py-2">Status</th>
                    <th className="hidden py-2 md:table-cell">Findings</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {admin.log.map((l) => (
                    <tr key={l.id}>
                      <td className="py-2 pr-3 text-gray-600">{new Date(l.at).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}</td>
                      <td className="py-2 pr-3 text-gray-700">{l.email}</td>
                      <td className="py-2 pr-3 text-gray-600">{l.mode === "dry_run" ? "Dry run" : l.mode === "test" ? "Test" : `Week of ${l.week}`}</td>
                      <td className="py-2 pr-3">
                        <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${STATUS_TONE[l.status] ?? "bg-field text-gray-600"}`} title={l.error ?? undefined}>
                          {l.status.replace("_", " ")}
                        </span>
                      </td>
                      <td className="hidden py-2 text-gray-600 md:table-cell">{l.items}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="mt-2 text-sm text-gray-500">Nothing sent yet.</p>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
