import { Form, Link, redirect, useNavigation } from "react-router";

import type { Route } from "./+types/books.entries.$id";
import { prisma } from "~/lib/db.server";
import { readFormData } from "~/lib/form.server";
import { Forbidden } from "~/lib/authorize.server";
import { requireBook } from "~/lib/books-app/access.server";
import { isAccountantRole, money } from "~/lib/books-app/format";
import { BooksError, cancelDocument, discardDraft, draftTotals, getDocument, postDocument, setDocumentTags } from "~/lib/books/books.server";
import { activityText, actorLabel } from "~/lib/books/activity";
import { formatDate } from "~/lib/books/dates";
import { DOC_LABELS, type DocType } from "~/lib/books/posting";
import { Notice } from "~/components/metrics/Metrics";
import { Card, Money, buttonClass, inputClass, quietButtonClass } from "~/components/books/BooksUi";

export function meta() {
  return [{ title: "Entry · Books · Growzar" }];
}

/**
 * One entry (B4): what it posts, line by line, and what happened to it. A
 * draft can be saved to the books or thrown away; a saved entry is never
 * changed, only cancelled with a reason, which posts a mirror entry (on its
 * own day if that's open, else the first open day).
 */
export async function loader({ request, params, url }: Route.LoaderArgs) {
  const { viewer, book, canManage } = await requireBook(request, "view");
  const found = await getDocument(book, params.id);
  if (!found) throw new Response("Not found", { status: 404 });
  const { doc, contact, events } = found;
  const accountant = isAccountantRole(viewer.role);
  const accountIds = [...new Set(doc.entries.flatMap((e) => e.lines.map((l) => l.accountId)))];
  const [accounts, store, total] = await Promise.all([
    prisma.bkAccount.findMany({ where: { bookId: book.id, id: { in: accountIds } }, select: { id: true, code: true, name: true } }),
    doc.storeId ? prisma.store.findUnique({ where: { id: doc.storeId }, select: { shopDomain: true, displayName: true } }) : null,
    doc.status === "draft" ? draftTotals(book, [doc]).then((m) => m.get(doc.id) ?? 0n) : Promise.resolve(doc.total),
  ]);
  const acc = new Map(accounts.map((a) => [a.id, `${a.code} · ${a.name}`]));
  const users = await prisma.user.findMany({ where: { id: { in: [...new Set(events.map((e) => e.actor).filter((x): x is string => !!x))] } }, select: { id: true, name: true } });
  const userName = new Map(users.map((u) => [u.id, u.name]));
  return {
    saved: url.searchParams.get("saved"),
    canManage,
    doc: {
      id: doc.id,
      label: DOC_LABELS[doc.type as DocType] ?? doc.type,
      number: doc.number,
      status: doc.status,
      date: formatDate(doc.date.toISOString().slice(0, 10)),
      memo: doc.memo,
      source: doc.source,
      contact: contact?.name ?? null,
      store: store ? store.displayName ?? store.shopDomain : null,
      total: money(book, total, accountant),
      tags: doc.tags,
      cancelReason: doc.cancelReason,
      updatedAt: doc.updatedAt.toISOString(),
    },
    entries: doc.entries.map((e) => ({
      id: e.id,
      kind: e.kind,
      date: formatDate(e.date.toISOString().slice(0, 10)),
      lines: e.lines.map((l) => ({ id: l.id.toString(), account: acc.get(l.accountId) ?? "An account", debit: l.amount > 0n ? money(book, l.amount, accountant) : "", credit: l.amount < 0n ? money(book, -l.amount, accountant) : "", description: l.description })),
    })),
    events: events.map((e) => {
      const line = activityText({ action: e.action, detail: (e.detail ?? {}) as Record<string, unknown>, documentId: null }, { account: () => null, contact: () => null, document: () => null });
      return { id: e.id.toString(), at: e.createdAt.toISOString(), who: e.actor ? userName.get(e.actor) ?? actorLabel(e.actor, viewer.userId) : "Automatic", text: line.text };
    }),
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const { viewer, book, canManage } = await requireBook(request, "view");
  if (!canManage) throw new Forbidden("Your role does not allow manage on books.");
  const form = await readFormData(request);
  const intent = String(form.get("intent") ?? "");
  try {
    switch (intent) {
      case "post":
        await postDocument(book, params.id, viewer.userId, String(form.get("updatedAt") ?? "") || undefined);
        throw redirect(`/books/entries/${params.id}?saved=posted`);
      case "discard":
        await discardDraft(book, params.id, viewer.userId);
        throw redirect("/books/entries?status=draft");
      case "cancel":
        await cancelDocument(book, params.id, String(form.get("reason") ?? ""), viewer.userId);
        throw redirect(`/books/entries/${params.id}?saved=cancelled`);
      case "tags":
        await setDocumentTags(book, params.id, String(form.get("tags") ?? "").split(",").map((t) => t.trim()).filter(Boolean), viewer.userId);
        return { ok: "Tags saved." };
      default:
        return { error: "Nothing to do." };
    }
  } catch (e) {
    if (e instanceof BooksError) return { error: e.message };
    throw e;
  }
}

const SAVED: Record<string, string> = { posted: "Saved to the books.", draft: "Kept as a draft. Save it to the books when it's right.", cancelled: "Cancelled. A mirror entry takes it back out of the books; nothing was deleted." };

export default function EntryPage({ loaderData: d, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  const x = d.doc;
  return (
    <div className="space-y-5">
      {d.saved && SAVED[d.saved] ? <Notice>{SAVED[d.saved]}</Notice> : null}
      {actionData && "error" in actionData ? <Notice tone="warn">{actionData.error}</Notice> : null}
      {actionData && "ok" in actionData ? <Notice>{actionData.ok}</Notice> : null}

      <Card
        title={`${x.number ?? "Draft"} · ${x.label}`}
        aside={
          <Link to="/books/entries" className="text-sm font-semibold text-accent-600">
            All entries
          </Link>
        }
      >
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
          <dt className="text-gray-500">Date</dt>
          <dd>{x.date}</dd>
          <dt className="text-gray-500">State</dt>
          <dd>{x.status === "draft" ? "Draft: not in the books yet" : x.status === "posted" ? "Saved to the books" : `Cancelled${x.cancelReason ? `: ${x.cancelReason}` : ""}`}</dd>
          <dt className="text-gray-500">Total</dt>
          <dd>
            <Money value={x.total} />
          </dd>
          {x.contact ? (
            <>
              <dt className="text-gray-500">With</dt>
              <dd>{x.contact}</dd>
            </>
          ) : null}
          {x.store ? (
            <>
              <dt className="text-gray-500">Store</dt>
              <dd>{x.store}</dd>
            </>
          ) : null}
          {x.memo ? (
            <>
              <dt className="text-gray-500">Memo</dt>
              <dd>{x.memo}</dd>
            </>
          ) : null}
          <dt className="text-gray-500">From</dt>
          <dd>{x.source === "manual" ? "Recorded by hand" : "Brought in automatically"}</dd>
        </dl>
        {d.canManage ? (
          <div className="flex flex-wrap items-start gap-3 pt-1">
            {x.status === "draft" ? (
              <>
                <Form method="post">
                  <input type="hidden" name="updatedAt" value={x.updatedAt} />
                  <button type="submit" name="intent" value="post" className={buttonClass} disabled={busy}>
                    Save to the books
                  </button>
                </Form>
                <Form method="post">
                  <button type="submit" name="intent" value="discard" className={quietButtonClass} disabled={busy}>
                    Throw away this draft
                  </button>
                </Form>
              </>
            ) : null}
            {x.status === "posted" ? (
              <details>
                <summary className={`${quietButtonClass} cursor-pointer list-none`}>Cancel this entry</summary>
                <Form method="post" className="mt-2 flex flex-wrap gap-2">
                  <input name="reason" required placeholder="Why (kept in the activity log)" className={`${inputClass} md:w-80`} />
                  <button type="submit" name="intent" value="cancel" className={buttonClass} disabled={busy}>
                    Cancel it
                  </button>
                </Form>
              </details>
            ) : null}
          </div>
        ) : null}
      </Card>

      {d.entries.map((e) => (
        <Card key={e.id} title={e.kind === "cancel" ? `Cancelled on ${e.date}` : `In the books on ${e.date}`}>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500">
                <th className="py-1 font-medium">Account</th>
                <th className="py-1 text-right font-medium">Debit</th>
                <th className="py-1 text-right font-medium">Credit</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {e.lines.map((l) => (
                <tr key={l.id}>
                  <td className="py-1.5">
                    {l.account}
                    {l.description ? <span className="ml-1.5 text-xs text-gray-500">{l.description}</span> : null}
                  </td>
                  <td className="py-1.5 text-right tabular-nums">{l.debit}</td>
                  <td className="py-1.5 text-right tabular-nums">{l.credit}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ))}

      <Card title="Tags">
        {d.canManage ? (
          <Form method="post" className="flex flex-wrap gap-2">
            <input name="tags" defaultValue={x.tags.join(", ")} placeholder="Website, Brand A" aria-label="Tags" className={`${inputClass} md:w-96`} />
            <button type="submit" name="intent" value="tags" className={quietButtonClass} disabled={busy}>
              Save tags
            </button>
          </Form>
        ) : (
          <p className="text-sm text-gray-700">{x.tags.join(", ") || "None"}</p>
        )}
        <p className="text-xs text-gray-500">Labels for reports by tag. They aren't part of the ledger, so saved entries can be tagged too.</p>
      </Card>

      <Card title="What happened">
        <ul className="space-y-1.5 text-sm">
          {d.events.map((e) => (
            <li key={e.id} className="text-gray-700">
              <span className="text-gray-500">{new Date(e.at).toLocaleString("en-GB")}</span> · {e.who}: {e.text}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
