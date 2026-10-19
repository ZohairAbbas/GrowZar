import { useState } from "react";
import { Link } from "react-router";
import { ChevronDown, ExternalLink, ThumbsDown, ThumbsUp } from "lucide-react";

import type { ToolResult } from "~/lib/ask/types";
import { cellText, chartOf, drawn, shownColumns, spansOf, type ChartSpec } from "~/lib/ask/view";

/**
 * One answer on the Ask screen (G-GZR10-3): the model's words, then each
 * table it drew on, drawn from the tool result itself, with how it was
 * computed and the screen that shows the same numbers.
 */

/** The model's text: paragraphs and "- " lists, **bold**, and (table N) as a link to that table. */
export function AnswerText({ text, idPrefix }: { text: string; idPrefix: string }) {
  const lines = text.split("\n");
  const blocks: Array<{ list: boolean; lines: string[] }> = [];
  for (const l of lines) {
    const t = l.trim();
    if (!t) {
      blocks.push({ list: false, lines: [] });
      continue;
    }
    const list = /^[-*•]\s+/.test(t);
    const last = blocks.at(-1);
    const line = list ? t.replace(/^[-*•]\s+/, "") : t;
    if (last && last.list === list && (list || last.lines.length)) last.lines.push(line);
    else blocks.push({ list, lines: [line] });
  }
  const inline = (line: string) =>
    spansOf(line).map((s, i) =>
      s.table ? (
        <a key={i} href={`#${idPrefix}-t${s.table}`} className="whitespace-nowrap text-sm text-accent-600 hover:underline">
          {s.text}
        </a>
      ) : s.bold ? (
        <strong key={i} className="font-semibold text-gray-900">
          {s.text}
        </strong>
      ) : (
        <span key={i}>{s.text}</span>
      ),
    );
  return (
    <div className="space-y-2 leading-relaxed text-gray-800" dir="auto">
      {blocks
        .filter((b) => b.lines.length)
        .map((b, i) =>
          b.list ? (
            <ul key={i} className="list-disc space-y-1 pl-5">
              {b.lines.map((l, j) => (
                <li key={j}>{inline(l)}</li>
              ))}
            </ul>
          ) : (
            <p key={i}>{b.lines.map((l, j) => (j ? [<br key={`b${j}`} />, ...inline(l)] : inline(l)))}</p>
          ),
        )}
    </div>
  );
}

/** One figure as horizontal bars (a ranking) or columns (a series in time). Single series: no legend; the heading names it. */
export function BarChart({ spec }: { spec: ChartSpec }) {
  const [hover, setHover] = useState<number | null>(null);
  const values = spec.points.map((p) => p.value ?? 0);
  const max = Math.max(0, ...values);
  const min = Math.min(0, ...values);
  const span = max - min || 1;
  const v = (x: number | null) => cellText(spec.value, x);
  if (!spec.time) {
    // A ranking: a row per entry, the bar from zero, the value beside it.
    return (
      <figure className="space-y-1.5" aria-label={`${spec.value.label} by ${spec.label.label.toLowerCase()}`}>
        {spec.points.map((p, i) => {
          const w = p.value === null ? 0 : (Math.abs(p.value) / Math.max(Math.abs(max), Math.abs(min), 1e-9)) * 100;
          return (
            <div key={i} className="grid grid-cols-[minmax(0,10rem)_1fr_auto] items-center gap-3 text-sm">
              <span className="truncate text-gray-700" title={p.label}>
                {p.label}
              </span>
              <span className="h-2.5 rounded-r bg-field">
                {p.value !== null ? <span className={`block h-2.5 rounded-r ${p.value < 0 ? "bg-coral-700" : "bg-data-700"}`} style={{ width: `${Math.max(w, 1)}%` }} /> : null}
              </span>
              <span className="tabular-nums text-gray-700">{v(p.value)}</span>
            </div>
          );
        })}
      </figure>
    );
  }
  // A series: columns in date order with a 2px gap; a missing value is a gap.
  const h = 120;
  const n = spec.points.length;
  const bw = 100 / n;
  const zero = h - ((0 - min) / span) * h;
  const shown = hover !== null ? spec.points[hover]! : null;
  return (
    <figure className="space-y-1">
      <div className="h-5 text-xs text-gray-600" aria-live="polite">
        {shown ? `${shown.label}: ${v(shown.value)}` : `${spec.points[0]!.label} to ${spec.points.at(-1)!.label}`}
      </div>
      <svg viewBox={`0 0 100 ${h}`} preserveAspectRatio="none" className="h-32 w-full" role="img" aria-label={`${spec.value.label} by ${spec.label.label.toLowerCase()}`} onMouseLeave={() => setHover(null)}>
        <line x1="0" x2="100" y1={zero} y2={zero} className="stroke-gray-200" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        {spec.points.map((p, i) => {
          if (p.value === null) return null;
          const y = h - ((p.value - min) / span) * h;
          const top = Math.min(y, zero);
          return (
            <rect
              key={i}
              x={i * bw + bw * 0.1}
              width={bw * 0.8}
              y={top}
              height={Math.max(Math.abs(zero - y), 0.5)}
              rx="0.6"
              className={hover === i ? "fill-navy" : p.value < 0 ? "fill-coral-700" : "fill-data-700"}
            />
          );
        })}
        {/* Hit targets the full column, wider than the mark. */}
        {spec.points.map((_, i) => (
          <rect key={`h${i}`} x={i * bw} width={bw} y="0" height={h} fill="transparent" onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} tabIndex={0} aria-label={`${spec.points[i]!.label}: ${v(spec.points[i]!.value)}`} />
        ))}
      </svg>
    </figure>
  );
}

function Table({ r }: { r: ToolResult }) {
  const cols = shownColumns(r);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-100 text-left text-xs text-gray-500">
            {cols.map((c) => (
              <th key={c.key} className={`px-2 py-1.5 font-medium ${c.kind === "text" || c.kind === "date" ? "" : "text-right"}`}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {r.rows.map((row, i) => (
            <tr key={i} className="border-b border-gray-50 last:border-0">
              {cols.map((c) => (
                <td key={c.key} className={`px-2 py-1.5 ${c.kind === "text" || c.kind === "date" ? "text-gray-800" : "text-right tabular-nums text-gray-700"}`}>
                  {cellText(c, row[c.key])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ResultCard({ r, table, idPrefix }: { r: ToolResult; table: number; idPrefix: string }) {
  const chart = chartOf(r);
  const m = r.meta;
  return (
    <section id={`${idPrefix}-t${table}`} className="space-y-3 rounded-2xl bg-white p-4">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-semibold text-gray-900">
          <span className="mr-2 text-xs font-medium text-gray-500">Table {table}</span>
          {r.title}
        </h3>
        {m.period ? (
          <span className="text-xs text-gray-500">
            {m.period.from} to {m.period.to}
            {m.stores.length ? ` · ${m.stores.map((s) => s.name).join(", ")}` : ""}
          </span>
        ) : null}
      </header>
      {chart ? <BarChart spec={chart} /> : null}
      <Table r={r} />
      {m.truncated ? (
        <p className="text-xs text-gray-500">
          Showing {m.truncated.shown} of {m.truncated.total} rows.
        </p>
      ) : null}
      <details className="group text-sm">
        <summary className="flex cursor-pointer list-none items-center gap-1 text-gray-600 hover:text-gray-900">
          <ChevronDown className="h-4 w-4 transition group-open:rotate-180" /> How this was computed
        </summary>
        <div className="mt-2 space-y-2 text-gray-600">
          {m.against ? <p>Compared with {m.against.from} to {m.against.to}.</p> : null}
          {m.rules.length ? (
            <ul className="list-disc space-y-0.5 pl-5">
              {m.rules.map((x, i) => (
                <li key={i}>{x}</li>
              ))}
            </ul>
          ) : null}
          {m.gaps.length ? (
            <div>
              <p className="font-medium text-gray-700">What's missing behind these numbers</p>
              <ul className="list-disc space-y-0.5 pl-5">
                {m.gaps.map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {m.notes.length ? (
            <ul className="list-disc space-y-0.5 pl-5">
              {m.notes.map((x, i) => (
                <li key={i}>{x}</li>
              ))}
            </ul>
          ) : null}
        </div>
      </details>
      {r.link ? (
        <p className="text-sm">
          {r.link.exact ? (
            <Link to={r.link.href} className="inline-flex items-center gap-1 font-semibold text-accent-600 hover:underline">
              {r.link.label} <ExternalLink className="h-3.5 w-3.5" />
            </Link>
          ) : (
            <span className="text-gray-600">
              Not on a screen yet. Closest:{" "}
              <Link to={r.link.href} className="font-semibold text-accent-600 hover:underline">
                {r.link.label}
              </Link>
            </span>
          )}
        </p>
      ) : null}
    </section>
  );
}

export function Feedback({ messageId, initial }: { messageId: string; initial: "up" | "down" | null }) {
  const [given, setGiven] = useState(initial);
  const [note, setNote] = useState("");
  const [sent, setSent] = useState(false);
  const send = async (feedback: "up" | "down", withNote?: string) => {
    setGiven(feedback);
    // A thumb alone leaves an earlier note as it was.
    await fetch("/api/ask/feedback", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messageId, feedback, ...(withNote !== undefined ? { note: withNote } : {}) }) });
    if (withNote !== undefined) setSent(true);
  };
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm text-gray-500">
      <span>Was this right?</span>
      <button type="button" aria-label="Yes" aria-pressed={given === "up"} onClick={() => send("up")} className={`rounded-full p-1.5 hover:bg-field ${given === "up" ? "bg-mint-100 text-mint-700" : ""}`}>
        <ThumbsUp className="h-4 w-4" />
      </button>
      <button type="button" aria-label="No" aria-pressed={given === "down"} onClick={() => send("down")} className={`rounded-full p-1.5 hover:bg-field ${given === "down" ? "bg-coral-100 text-coral-700" : ""}`}>
        <ThumbsDown className="h-4 w-4" />
      </button>
      {given === "down" && !sent ? (
        <form
          className="flex flex-1 items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void send("down", note.trim().slice(0, 500));
          }}
        >
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="What was wrong? (optional)" className="min-w-0 flex-1 rounded-full border border-gray-200 px-3 py-1 text-sm" />
          <button type="submit" className="rounded-full bg-field px-3 py-1 font-semibold text-gray-700 hover:bg-gray-100">
            Send
          </button>
        </form>
      ) : null}
      {sent ? <span>Thanks, noted.</span> : null}
    </div>
  );
}

/** Every drawable table of an answer, numbered as the answer cites them. */
export function AnswerTables({ results, idPrefix }: { results: Array<{ table: number; result: ToolResult }>; idPrefix: string }) {
  const shown = results.filter((x) => drawn(x.result));
  if (!shown.length) return null;
  return (
    <div className="space-y-3">
      {shown.map((x) => (
        <ResultCard key={x.table} r={x.result} table={x.table} idPrefix={idPrefix} />
      ))}
    </div>
  );
}
