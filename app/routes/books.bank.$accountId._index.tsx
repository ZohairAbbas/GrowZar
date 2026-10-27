import { Form, Link, useNavigation } from "react-router";
import { Check } from "lucide-react";

import type { Route } from "./+types/books.bank.$accountId._index";
import { readFormData } from "~/lib/form.server";
import { Forbidden } from "~/lib/authorize.server";
import { requireBook } from "~/lib/books-app/access.server";
import { isAccountantRole, money } from "~/lib/books-app/format";
import { applySuggestions, matchStatementLine, recordFromStatementLine, setStatementLineIgnored, statementReview, unmatchStatementLine, type SuggestionItem } from "~/lib/books/bank.server";
import { BooksError, listAccounts } from "~/lib/books/books.server";
import { formatDate } from "~/lib/books/dates";
import { Notice } from "~/components/metrics/Metrics";
import { Card, Money, buttonClass, inputClass, quietButtonClass } from "~/components/books/BooksUi";

export function meta() {
  return [{ title: "Statement · Books · Growzar" }];
}

/**
 * One account's statement lines (B5): each open line with what it most likely
 * is — an entry already in the books (a courier payout: "received in bank"),
 * a group of them, a bill it pays, a rule's account — to match, record, or
 * ignore. Matched and ignored lines can be taken back.
 */
export async function loader({ request, params, url }: Route.LoaderArgs) {
  const { viewer, book, canManage } = await requireBook(request, "view");
  const show = url.searchParams.get("show") ?? "open";
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);
  let review;
  try {
    review = await statementReview(book, params.accountId, { show, page });
  } catch (e) {
    if (e instanceof BooksError) throw new Response(e.message, { status: 404 });
    throw e;
  }
  const accountant = isAccountantRole(viewer.role);
  const m = (v: bigint) => money(book, v, accountant);
  const accounts = (await listAccounts(book)).filter((a) => !a.archived && (a.type === "expense" || a.type === "income" || (a.type === "asset" && a.subtype !== "receivable")));
  const p = url.searchParams;
  return {
    canManage,
    imported: p.has("added") ? { added: Number(p.get("added")), duplicates: Number(p.get("duplicates")), problems: Number(p.get("problems")), possible: Number(p.get("possible")) } : null,
    account: review.account,
    show: review.show,
    counts: review.counts,
    page: review.page,
    pages: Math.max(1, Math.ceil(review.count / review.pageSize)),
    accounts: accounts.map((a) => ({ id: a.id, name: `${a.code} · ${a.name}`, type: a.type })),
    lines: review.lines.map((l) => ({
      id: l.id,
      date: formatDate(l.date),
      description: l.description,
      out: l.amount < 0n,
      amount: m(l.amount),
      matched: l.matched ? { id: l.matched.id, label: [l.matched.number, l.matched.kind, l.matched.contactName].filter(Boolean).join(" · ") } : null,
      suggestion: l.suggestion ? { entryLineId: l.suggestion.entryLineId, strength: l.suggestion.strength, label: [l.suggestion.number, l.suggestion.kind, l.suggestion.contactName, formatDate(l.suggestion.date)].filter(Boolean).join(" · ") } : null,
      group: l.group ? { lineIds: l.group.lineIds, entryLineIds: l.group.entries.map((e) => e.entryLineId), label: `${l.group.lines.length} line${l.group.lines.length === 1 ? "" : "s"} with ${l.group.entries.length} entr${l.group.entries.length === 1 ? "y" : "ies"}: ${l.group.entries.map((e) => e.number).filter(Boolean).join(", ")}` } : null,
      reversal: l.reversal ? { lineId: l.reversal.lineId, label: `Reversed on ${formatDate(l.reversal.date)}: ${l.reversal.description}` } : null,
      settle: l.settle ? { id: l.settle.id, amount: l.settle.open.toString(), label: `Pays ${l.settle.number}${l.settle.contactName ? ` from ${l.settle.contactName}` : ""}` } : null,
      rule: l.rule ? { id: l.rule.id, accountId: l.rule.accountId, contactId: l.rule.contactId, label: `${l.rule.accountName}${l.rule.contactName ? ` · ${l.rule.contactName}` : ""}` } : null,
      named: l.named,
      duplicate: l.duplicateOf ? `Looks like a line already imported on ${formatDate(l.duplicateOf.date)}${l.duplicateOf.fileName ? ` (${l.duplicateOf.fileName})` : ""}` : null,
      ruleWords: l.ruleWords,
    })),
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const { viewer, book, canManage } = await requireBook(request, "view");
  if (!canManage) throw new Forbidden("Your role does not allow manage on books.");
  const form = await readFormData(request);
  const str = (k: string) => String(form.get(k) ?? "");
  try {
    switch (str("intent")) {
      case "match":
        await matchStatementLine(book, str("lineId"), str("entryLineId"));
        return { ok: "Matched." };
      case "apply": {
        const items = JSON.parse(str("items") || "[]") as SuggestionItem[];
        const r = await applySuggestions(book, items, viewer.userId);
        const bad = r.filter((x) => !x.ok);
        return bad.length ? { error: `${r.length - bad.length} done; ${bad.length} couldn't be: ${bad.slice(0, 3).map((x) => x.message).join("; ")}` } : { ok: `${r.length} done.` };
      }
      case "record": {
        const r = await recordFromStatementLine(book, str("lineId"), { accountId: str("accountId"), newContactName: str("contact") || null, remember: form.get("remember") === "on", ruleWords: str("ruleWords") || null }, viewer.userId);
        return { ok: `Recorded as ${r.number}${r.linked ? " and matched" : ""}.` };
      }
      case "ignore":
      case "unignore":
        await setStatementLineIgnored(book, str("lineId"), str("intent") === "ignore");
        return { ok: str("intent") === "ignore" ? "Ignored." : "Back to review." };
      case "unmatch":
        await unmatchStatementLine(book, str("lineId"));
        return { ok: "Unmatched; it's back to review." };
      default:
        return { error: "Nothing to do." };
    }
  } catch (e) {
    if (e instanceof BooksError) return { error: e.message };
    if (e instanceof SyntaxError) return { error: "Something went wrong sending that. Try again." };
    throw e;
  } finally {
    void params;
  }
}

export default function StatementReview({ loaderData: d, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  // "Accept every suggestion" takes only the strong ones: a match, a group, a reversal, a bill it pays, a rule.
  const all: SuggestionItem[] = d.lines.flatMap((l): SuggestionItem[] => {
    if (l.suggestion && l.suggestion.strength === "strong") return [{ lineId: l.id, kind: "match", entryLineId: l.suggestion.entryLineId }];
    if (l.group) return [{ lineId: l.id, kind: "group", lineIds: l.group.lineIds, entryLineIds: l.group.entryLineIds }];
    if (l.reversal) return [{ lineId: l.id, kind: "reversal", otherLineId: l.reversal.lineId }];
    if (l.rule) return [{ lineId: l.id, kind: "record", accountId: l.rule.accountId, contactId: l.rule.contactId, ruleId: l.rule.id }];
    return [];
  });
  const tab = (s: string, label: string, n: number) => (
    <Link to={`?show=${s}`} className={`tap rounded-full px-3.5 py-1.5 text-sm font-semibold ${d.show === s ? "bg-navy text-white" : "bg-white text-gray-700 hover:bg-gray-100"}`}>
      {label} · {n}
    </Link>
  );
  return (
    <div className="space-y-5">
      {d.imported ? (
        <Notice>
          {d.imported.added} line{d.imported.added === 1 ? "" : "s"} imported{d.imported.duplicates ? `, ${d.imported.duplicates} already here` : ""}{d.imported.possible ? `, ${d.imported.possible} look like repeats (marked below)` : ""}{d.imported.problems ? `, ${d.imported.problems} couldn't be read` : ""}.
        </Notice>
      ) : null}
      {actionData && "ok" in actionData ? <Notice>{actionData.ok}</Notice> : null}
      {actionData && "error" in actionData ? <Notice tone="warn">{actionData.error}</Notice> : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5">
          {tab("open", "To match", d.counts.open)}
          {tab("matched", "Matched", d.counts.matched)}
          {tab("ignored", "Ignored", d.counts.ignored)}
        </div>
        <span className="flex gap-3 text-sm font-semibold">
          <Link to={`/books/bank/${d.account.id}/reconcile`} className="text-accent-600">
            Reconcile
          </Link>
          <Link to={`/books/bank/import?account=${d.account.id}`} className="text-accent-600">
            Import another statement
          </Link>
        </span>
      </div>

      <Card
        title={d.account.name}
        aside={
          d.canManage && d.show === "open" && all.length ? (
            <Form method="post">
              <input type="hidden" name="items" value={JSON.stringify(all)} />
              <button type="submit" name="intent" value="apply" className={buttonClass} disabled={busy}>
                <Check className="h-4 w-4" /> Accept {all.length} suggestion{all.length === 1 ? "" : "s"}
              </button>
            </Form>
          ) : null
        }
      >
        {d.lines.length === 0 ? <p className="text-sm text-gray-500">{d.show === "open" ? "Every line is matched or recorded." : "Nothing here."}</p> : null}
        <ul className="divide-y divide-gray-100">
          {d.lines.map((l) => (
            <li key={l.id} className="space-y-2 py-3">
              <div className="grid gap-1 text-sm md:grid-cols-[110px_1fr_150px]">
                <span className="text-gray-500">{l.date}</span>
                <span className="min-w-0 break-words text-gray-900">{l.description}</span>
                <Money value={l.amount} className="font-semibold md:text-right" />
              </div>
              {l.duplicate ? <p className="text-xs text-coral-700">{l.duplicate}</p> : null}
              {d.canManage ? (
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  {l.matched ? (
                    <>
                      <Link to={`/books/entries/${l.matched.id}`} className="text-accent-600">
                        {l.matched.label}
                      </Link>
                      <Form method="post">
                        <input type="hidden" name="lineId" value={l.id} />
                        <button type="submit" name="intent" value="unmatch" className={quietButtonClass} disabled={busy}>
                          Unmatch
                        </button>
                      </Form>
                    </>
                  ) : d.show === "ignored" ? (
                    <Form method="post">
                      <input type="hidden" name="lineId" value={l.id} />
                      <button type="submit" name="intent" value="unignore" className={quietButtonClass} disabled={busy}>
                        Bring back
                      </button>
                    </Form>
                  ) : (
                    <>
                      {l.suggestion ? (
                        <Form method="post" className="flex items-center gap-2">
                          <input type="hidden" name="lineId" value={l.id} />
                          <input type="hidden" name="entryLineId" value={l.suggestion.entryLineId} />
                          <span className="text-gray-600">{l.suggestion.strength === "strong" ? "Is" : "Could be"} {l.suggestion.label}</span>
                          <button type="submit" name="intent" value="match" className={quietButtonClass} disabled={busy}>
                            Match
                          </button>
                        </Form>
                      ) : null}
                      {!l.suggestion && (l.group || l.reversal || l.settle || l.rule) ? (
                        <Form method="post" className="flex items-center gap-2">
                          <input
                            type="hidden"
                            name="items"
                            value={JSON.stringify([
                              l.group
                                ? { lineId: l.id, kind: "group", lineIds: l.group.lineIds, entryLineIds: l.group.entryLineIds }
                                : l.reversal
                                  ? { lineId: l.id, kind: "reversal", otherLineId: l.reversal.lineId }
                                  : l.settle
                                    ? { lineId: l.id, kind: "settle", items: [{ id: l.settle.id, amount: l.settle.amount }] }
                                    : { lineId: l.id, kind: "record", accountId: l.rule!.accountId, contactId: l.rule!.contactId, ruleId: l.rule!.id },
                            ])}
                          />
                          <span className="text-gray-600">{l.group?.label ?? l.reversal?.label ?? l.settle?.label ?? `By your rule: ${l.rule!.label}`}</span>
                          <button type="submit" name="intent" value="apply" className={quietButtonClass} disabled={busy}>
                            Accept
                          </button>
                        </Form>
                      ) : null}
                      <details>
                        <summary className={`${quietButtonClass} cursor-pointer list-none`}>Record it</summary>
                        <Form method="post" className="mt-2 grid gap-2 md:grid-cols-[1.2fr_1fr_auto_auto]">
                          <input type="hidden" name="lineId" value={l.id} />
                          <input type="hidden" name="ruleWords" value={l.ruleWords} />
                          <select name="accountId" required aria-label="Account" className={inputClass} defaultValue={l.named?.accountId ?? ""}>
                            <option value="">{l.out ? "What it paid for…" : "What it was for…"}</option>
                            {d.accounts
                              .filter((a) => (l.out ? a.type !== "income" : a.type !== "expense"))
                              .map((a) => (
                                <option key={a.id} value={a.id}>
                                  {a.name}
                                </option>
                              ))}
                          </select>
                          <input name="contact" placeholder={l.out ? "Paid to (optional)" : "From (optional)"} defaultValue={l.named?.contactName ?? ""} aria-label="Contact" className={inputClass} />
                          <label className="flex items-center gap-1.5 text-xs text-gray-600">
                            <input type="checkbox" name="remember" className="h-4 w-4" /> Remember for “{l.ruleWords}”
                          </label>
                          <button type="submit" name="intent" value="record" className={buttonClass} disabled={busy}>
                            Record
                          </button>
                        </Form>
                      </details>
                      <Form method="post">
                        <input type="hidden" name="lineId" value={l.id} />
                        <button type="submit" name="intent" value="ignore" className="text-xs font-semibold text-gray-500 hover:text-gray-800" disabled={busy}>
                          Ignore
                        </button>
                      </Form>
                    </>
                  )}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
        {d.pages > 1 ? (
          <div className="flex items-center gap-3 text-sm">
            {d.page > 1 ? <Link to={`?show=${d.show}&page=${d.page - 1}`} className="font-semibold text-accent-600">Previous</Link> : null}
            <span className="text-gray-500">
              Page {d.page} of {d.pages}
            </span>
            {d.page < d.pages ? <Link to={`?show=${d.show}&page=${d.page + 1}`} className="font-semibold text-accent-600">Next</Link> : null}
          </div>
        ) : null}
      </Card>
    </div>
  );
}
