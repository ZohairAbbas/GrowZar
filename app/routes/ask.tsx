import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { ArrowUp, MessageSquare, Plus, Sparkles } from "lucide-react";

import type { Route } from "./+types/ask";
import { prisma } from "~/lib/db.server";
import { hasPermission, listVisibleStores, requireSection } from "~/lib/authorize.server";
import { readStoreCookie } from "~/lib/store-cookie.server";
import { detectorLabel } from "~/lib/insights/detectors";
import { askEnabled, type AskEvent } from "~/lib/ask/loop.server";
import type { ToolResult } from "~/lib/ask/types";
import { guard } from "~/lib/ask/guard";
import { AnswerTables, AnswerText, Feedback } from "~/components/ask/Answer";

export function meta() {
  return [{ title: "Ask · Growzar" }];
}

/**
 * Ask about your stores (Phase 10, G-GZR10-3): a conversation with the
 * numbers. Anyone with Home may ask; each tool checks its own section. The
 * answer streams from POST /api/ask; its tables are drawn from the tool
 * results, never from the model's text.
 */
export async function loader({ request, url }: Route.LoaderArgs) {
  const viewer = await requireSection(request, "home", "view");
  const [settings, canManage, canSeeMoney, stores] = await Promise.all([
    prisma.askSettings.findUnique({ where: { organizationId: viewer.organizationId } }),
    hasPermission(request, viewer.organizationId, "settings", "manage"),
    hasPermission(request, viewer.organizationId, "finance", "view"),
    listVisibleStores(viewer),
  ]);
  const on = askEnabled() && Boolean(settings?.enabled);
  const remembered = readStoreCookie(request);
  const visible = new Set(stores.map((s) => s.id));
  const active = stores.find((s) => s.id === remembered) ?? stores[0] ?? null;
  if (!on) return { on, canManage, storeId: null, storeName: null, conversations: [], conversation: null, suggestions: [], q: null };

  const conversations = await prisma.askConversation.findMany({
    where: { organizationId: viewer.organizationId, userId: viewer.userId },
    orderBy: { startedAt: "desc" },
    take: 15,
    select: { id: true, startedAt: true, messages: { where: { role: "user" }, orderBy: { createdAt: "asc" }, take: 1, select: { text: true } } },
  });
  const cid = url.searchParams.get("c");
  const conversation = cid
    ? await prisma.askConversation.findFirst({
        where: { id: cid, organizationId: viewer.organizationId, userId: viewer.userId },
        select: { id: true, messages: { orderBy: { createdAt: "asc" }, select: { id: true, role: true, text: true, status: true, toolCalls: true, feedback: true } } },
      })
    : null;

  // Suggested questions from the store's own data: its busiest city and its top open finding.
  const suggestions: string[] = [];
  if (active) {
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    const [city, insight] = await Promise.all([
      prisma.orderGrain.groupBy({ by: ["city"], where: { storeId: active.id, city: { not: null }, localDay: { gte: since } }, _count: { _all: true }, orderBy: { _count: { city: "desc" } }, take: 1 }),
      prisma.insight.findFirst({ where: { storeId: active.id, status: "open" }, orderBy: { lastSeenAt: "desc" }, select: { detector: true } }),
    ]);
    if (insight) {
      try {
        suggestions.push(`What should I do about "${detectorLabel(insight.detector as Parameters<typeof detectorLabel>[0])}"?`);
      } catch {
        // A detector that no longer exists suggests nothing.
      }
    }
    if (city[0]?.city) suggestions.push(`${city[0].city} mein kaunsa courier best hai?`);
    suggestions.push("How did the last 30 days compare with the 30 before?", "Which products lost money last month?");
  }
  return {
    on,
    canManage,
    storeId: active?.id ?? null,
    storeName: active ? (active.displayName ?? active.shopDomain) : null,
    conversations: conversations.map((c) => ({ id: c.id, startedAt: c.startedAt.toISOString(), title: c.messages[0]?.text?.slice(0, 80) ?? "Redacted after 90 days" })),
    conversation: conversation
      ? {
          id: conversation.id,
          messages: conversation.messages.map((m) => ({
            id: m.id,
            role: m.role as "user" | "assistant",
            text: m.text,
            status: m.status,
            feedback: (m.feedback as "up" | "down" | null) ?? null,
            // Shown as the viewer may see them now: a role that has lost Finance, or a store, sees neither in old answers.
            tables: ((m.toolCalls as unknown as Array<{ table: number; result: ToolResult }> | null) ?? [])
              .filter((r) => r.result.meta.stores.every((s) => visible.has(s.id)))
              .map((r) => ({ table: r.table, result: guard(r.result, canSeeMoney) })),
          })),
        }
      : null,
    suggestions,
    q: url.searchParams.get("q")?.slice(0, 2_000) ?? null,
  };
}

type Turn = {
  id: string | null;
  role: "user" | "assistant";
  text: string | null;
  status: string | null;
  feedback: "up" | "down" | null;
  tables: Array<{ table: number; result: ToolResult }>;
  pending?: boolean;
};

export default function Ask({ loaderData }: Route.ComponentProps) {
  const { on, canManage, storeId, storeName, conversations, conversation, suggestions, q } = loaderData;
  const [turns, setTurns] = useState<Turn[]>(conversation?.messages ?? []);
  const [conversationId, setConversationId] = useState<string | null>(conversation?.id ?? null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const asked = useRef(false);
  const end = useRef<HTMLDivElement>(null);
  // The answer streaming now; dropped when another conversation opens, so its text can't land there.
  const inflight = useRef<AbortController | null>(null);

  useEffect(() => {
    inflight.current?.abort();
    setBusy(false);
    setTurns(conversation?.messages ?? []);
    setConversationId(conversation?.id ?? null);
  }, [conversation?.id]);
  useEffect(() => () => inflight.current?.abort(), []);
  useEffect(() => end.current?.scrollIntoView({ behavior: "smooth", block: "end" }), [turns.length]);

  async function ask(question: string) {
    const text = question.trim();
    if (!text || busy) return;
    setBusy(true);
    setDraft("");
    setTurns((t) => [...t, { id: null, role: "user", text, status: null, feedback: null, tables: [] }, { id: null, role: "assistant", text: "", status: null, feedback: null, tables: [], pending: true }]);
    const controller = new AbortController();
    inflight.current = controller;
    const update = (f: (a: Turn) => Turn) => {
      if (!controller.signal.aborted) setTurns((t) => [...t.slice(0, -1), f(t.at(-1)!)]);
    };
    try {
      const res = await fetch("/api/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: text, conversationId, storeId }), signal: controller.signal });
      if (!res.ok || !res.body) {
        const err = (await res.json().catch(() => null)) as { error?: string } | null;
        update((a) => ({ ...a, text: err?.error ?? "Something went wrong. Try again in a moment.", status: "error", pending: false }));
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let round = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const e = JSON.parse(line) as AskEvent;
          if (e.type === "start") {
            setConversationId(e.conversationId);
            window.history.replaceState(window.history.state, "", `/ask?c=${e.conversationId}`);
          } else if (e.type === "text") {
            // A later model call's text replaces an earlier one's.
            const fresh = e.round !== round;
            round = e.round;
            update((a) => ({ ...a, text: (fresh ? "" : (a.text ?? "")) + e.delta }));
          } else if (e.type === "tool") {
            update((a) => ({ ...a, tables: [...a.tables, { table: e.table, result: e.result }] }));
          } else if (e.type === "done") {
            // The checked answer replaces what streamed.
            update((a) => ({ ...a, id: e.messageId, text: e.text, status: e.status, pending: false }));
          }
        }
      }
    } catch {
      update((a) => ({ ...a, text: "The connection dropped. Try again.", status: "error", pending: false }));
    } finally {
      if (inflight.current === controller) {
        inflight.current = null;
        setBusy(false);
      }
    }
  }

  // A question from Home's box asks itself once; one from a link elsewhere only fills the box,
  // so another site can't make a member ask (and spend the organization's budget).
  useEffect(() => {
    if (q && on && !asked.current) {
      asked.current = true;
      window.history.replaceState(window.history.state, "", "/ask");
      const fromGrowzar = document.referrer !== "" && new URL(document.referrer).origin === window.location.origin;
      if (fromGrowzar) void ask(q);
      else setDraft(q);
    }
  }, [q, on]);

  if (!on) {
    return (
      <div className="max-w-2xl">
        <h1 className="font-display text-3xl font-bold tracking-tight text-gray-900">Ask</h1>
        <div className="mt-6 rounded-2xl bg-white p-6 text-gray-700">
          <p>Asking questions about your stores isn't turned on for this organization yet.</p>
          {canManage ? (
            <p className="mt-2">
              An owner or admin can turn it on in <Link to="/settings/ask" className="font-semibold text-accent-600 hover:underline">Settings → Ask</Link>.
            </p>
          ) : (
            <p className="mt-2 text-gray-600">Ask an owner or admin of your organization to turn it on.</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_16rem]">
      <div className="min-w-0">
        <header className="mb-4">
          <h1 className="font-display text-3xl font-bold tracking-tight text-gray-900">Ask</h1>
          <p className="mt-1 text-gray-600">
            Ask about {storeName ?? "your stores"} in English or Roman Urdu. Every figure comes from Growzar's own numbers, with the table it came from.
          </p>
        </header>

        <div className="space-y-5">
          {turns.length === 0 ? (
            <div className="flex flex-wrap gap-2">
              {suggestions.map((s) => (
                <button key={s} type="button" onClick={() => void ask(s)} className="inline-flex items-center gap-1.5 rounded-full bg-white px-3.5 py-2 text-sm text-gray-700 hover:bg-field" dir="auto">
                  <Sparkles className="h-3.5 w-3.5 text-accent-600" /> {s}
                </button>
              ))}
            </div>
          ) : null}
          {turns.map((t, i) =>
            t.role === "user" ? (
              <div key={i} className="ml-auto max-w-[85%] rounded-2xl bg-navy px-4 py-2.5 text-white" dir="auto">
                {t.text ?? "This question was removed after 90 days."}
              </div>
            ) : (
              <div key={i} className="space-y-3">
                <div className="rounded-2xl bg-white p-4">
                  {t.text ? <AnswerText text={t.text} idPrefix={`a${i}`} /> : t.pending ? <p className="animate-pulse text-gray-500">Looking at your numbers…</p> : <p className="text-gray-500">This answer was removed after 90 days.</p>}
                  {t.id && t.status === "answered" ? (
                    <div className="mt-3 border-t border-gray-100 pt-2">
                      <Feedback messageId={t.id} initial={t.feedback} />
                    </div>
                  ) : null}
                </div>
                <AnswerTables results={t.tables} idPrefix={`a${i}`} />
              </div>
            ),
          )}
          <div ref={end} />
        </div>

        <form
          className="sticky bottom-0 mt-6 flex items-end gap-2 bg-field py-3"
          onSubmit={(e) => {
            e.preventDefault();
            void ask(draft);
          }}
        >
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void ask(draft);
              }
            }}
            rows={2}
            maxLength={2000}
            dir="auto"
            placeholder="e.g. Which city returns the most parcels? · Pichle mahine ka profit kitna tha?"
            aria-label="Your question"
            className="min-w-0 flex-1 resize-none rounded-2xl border border-gray-200 bg-white px-4 py-3 text-sm focus:border-accent-500 focus:outline-none"
          />
          <button type="submit" disabled={busy || !draft.trim()} aria-label="Ask" className="flex h-11 w-11 items-center justify-center rounded-full bg-navy text-mint disabled:opacity-40">
            <ArrowUp className="h-5 w-5" />
          </button>
        </form>
      </div>

      <aside className="space-y-2">
        <Link to="/ask" reloadDocument className="flex items-center gap-2 rounded-full bg-white px-3.5 py-2 text-sm font-semibold text-gray-800 hover:bg-gray-100">
          <Plus className="h-4 w-4" /> New conversation
        </Link>
        {conversations.length ? <h2 className="px-1 pt-2 text-xs font-medium text-gray-500">Earlier</h2> : null}
        {conversations.map((c) => (
          <Link key={c.id} to={`/ask?c=${c.id}`} className={`flex items-start gap-2 rounded-xl px-3 py-2 text-sm hover:bg-white ${c.id === conversationId ? "bg-white font-semibold" : "text-gray-700"}`} dir="auto">
            <MessageSquare className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-gray-400" />
            <span className="line-clamp-2">{c.title}</span>
          </Link>
        ))}
      </aside>
    </div>
  );
}
