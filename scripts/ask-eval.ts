/**
 * The "talk to your data" eval (G-GZR10-5): about 100 questions, half
 * English, half Roman Urdu, over the Pilot organization's stores, asked of
 * the real model through the real loop (`answer`: no gates, nothing stored).
 *
 *   DATABASE_POOL=3 npx tsx --env-file=.env scripts/ask-eval.ts --model=gpt-6.1-sol [--model=gpt-6-luna] [--only=01,14] [--budget=3] > report.md
 *
 * Needs OPENAI_API_KEY. Runs past the gates (kill switch, switch, cap) and
 * its spend is not added to the organization's month: --budget is its cap.
 * Reads the stores' data; writes nothing to the
 * database except the insight rows Home also writes when the insights tool
 * runs. Prints Markdown; nothing buyer-identifying is printed (answers are
 * aggregates by construction, and pass the guard).
 *
 * Each case's expected figures come from calling the tools directly
 * (ask-eval.cases.ts names the call), never from hand-written numbers.
 * Scores, per pack §5:
 *  - right tool: the answer called one of the tools that answer it;
 *  - invented numbers: numbers in the model's text that match no tool
 *    result (counted before the number check drops them); the bar is 0;
 *  - correct numbers: every expected figure appears in the answer, at the
 *    precision it is written; the bar is 95% of answerable cases;
 *  - permission refusals: a staff question about money, buyers or
 *    marketing states none of the owner's figures; the bar is 100%;
 *  - out of scope and no data: no figure at all;
 *  - language: the answer is in the question's language; the bar is 90%.
 */
import { prisma } from "../app/lib/db.server";
import { roleChecker } from "../app/lib/role-check.server";
import { answer, type Recorded } from "../app/lib/ask/loop.server";
import { costMicros, PRICES } from "../app/lib/ask/llm.server";
import { runTool } from "../app/lib/ask/registry.server";
import { matches, numbersIn } from "../app/lib/ask/grounding";
import type { AskContext, Cell, ToolResult } from "../app/lib/ask/types";
import { localDayOf } from "../app/lib/metrics/order-grain";
import { cases, STORES, type Call, type Case } from "./ask-eval.cases";

const ORG = "4c9385d8-38fe-44fb-9709-261640cb92a6";
const arg = (name: string) => process.argv.filter((a) => a.startsWith(`--${name}=`)).map((a) => a.slice(name.length + 3));
const models = arg("model").length ? arg("model") : ["gpt-6.1-sol"];
const only = arg("only")[0]?.split(",");
const budgetUsd = Number(arg("budget")[0] ?? 3);
const concurrency = Number(arg("concurrency")[0] ?? 3);
for (const m of models) if (!PRICES[m]) throw new Error(`No price for ${m}`);

const now = new Date();
const today = localDayOf(now, "Asia/Karachi");
const can = await roleChecker(ORG);
const stores = await prisma.store.findMany({ where: { organizationId: ORG }, orderBy: { shopDomain: "asc" } });
const org = await prisma.organization.findUniqueOrThrow({ where: { id: ORG }, select: { baseCurrency: true } });

function ctxFor(role: string): AskContext {
  return {
    organizationId: ORG,
    userId: `eval-${role}`,
    baseCurrency: org.baseCurrency,
    stores: stores.map((s) => ({ id: s.id, name: s.displayName ?? s.shopDomain, currency: s.currency, timezone: s.timezone })),
    can: (section) => can(role, section, "view"),
    now,
    memo: new Map(),
    // Plan's tools (G-GZR11-7) as every organization has them (pre-Wave-1 pack 2), asked as a merchant: Beta wording, no backtests.
    planTools: can(role, "plan", "view"),
    riskTools: true,
    internal: false,
    // Books' tools (B7) follow the role, as the screens do.
    booksTools: can(role, "books", "view"),
  };
}

// ── Expected figures, from the tools ──

function cell(r: ToolResult, pick: Call["pick"][number]): Cell {
  const rows = r.rows;
  const row =
    pick.row === undefined
      ? rows[0]
      : typeof pick.row === "number"
        ? rows.at(pick.row)
        : rows.find((x) => String(x.key ?? "").toLowerCase() === String(pick.row).toLowerCase() || String(x.label ?? "").toLowerCase() === String(pick.row).toLowerCase());
  return row?.[pick.column] ?? null;
}

const ownerCtx = ctxFor("owner");
async function expected(c: Case): Promise<number[]> {
  const out: number[] = [];
  for (const call of c.expect ?? []) {
    const r = await runTool(call.tool, call.args, ownerCtx);
    for (const p of call.pick) {
      const v = cell(r, p);
      if (typeof v === "number") out.push(v);
    }
  }
  if (c.calc) {
    const a = cell(await runTool(c.calc.a.tool, c.calc.a.args, ownerCtx), c.calc.a.pick[0]!);
    const b = cell(await runTool(c.calc.b.tool, c.calc.b.args, ownerCtx), c.calc.b.pick[0]!);
    if (typeof a === "number" && typeof b === "number" && b !== 0) {
      const v = c.calc.op === "share" ? (100 * a) / b : a - b;
      out.push(Math.round(v * 10 ** c.calc.decimals) / 10 ** c.calc.decimals);
    }
  }
  return out;
}

// ── Language ──

const RU = new Set(["hai", "hain", "ka", "ki", "ke", "mein", "se", "aur", "nahi", "kya", "kitne", "kitna", "kitni", "ko", "tha", "thi", "thay", "yeh", "ye", "liye", "wala", "wali", "wale", "sab", "zyada", "kam", "abhi", "pichle", "hua", "hui", "hue", "gaye", "gayi", "par", "bhi", "lekin", "magar", "agar", "sakte", "sakta", "chahiye"]);
export function languageOf(text: string): "en" | "ru" | "ur" {
  if ((text.match(/[؀-ۿ]/g)?.length ?? 0) > 20) return "ur";
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  const ru = new Set(words.filter((w) => RU.has(w)));
  return ru.size >= 3 ? "ru" : "en";
}

// ── One case ──

type Outcome = {
  c: Case;
  model: string;
  text: string;
  status: string;
  tools: string[];
  toolOk: boolean;
  invented: string[];
  expected: number[];
  missing: number[];
  pass: { numbers: boolean | null; permission: boolean | null; scope: boolean | null; language: boolean; beta: boolean | null };
  costMicros: number;
  latencyMs: number;
  error?: string;
};

/** Figures an answer states, leaving out dates, small counts and zero ("0 orders" is how "none" is said). */
const MONTH = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?";
/** Dates written out: "September 20–October 19, 2026", "1–31 January", "Oct 5". */
const WRITTEN_DATE = new RegExp(`\\b(?:${MONTH}\\s+\\d{1,2}\\b(?:\\s*[–-]\\s*(?:${MONTH}\\s+)?\\d{1,2}\\b)?|\\d{1,2}(?:\\s*[–-]\\s*\\d{1,2})?\\s+${MONTH})(?:,?\\s*\\d{4})?`, "gi");
const stated = (text: string) =>
  numbersIn(text.replace(/\b\d{4}-\d{2}-\d{2}\b/g, " ").replace(WRITTEN_DATE, " ")).filter((f) => f.value !== 0 && !/^20\d\d$/.test(f.text) && !(f.decimals === 0 && f.scale === 1 && !f.percent && Math.abs(f.value) <= 10));

async function runCase(c: Case, model: string): Promise<Outcome> {
  const exp = await expected(c);
  const ctx = ctxFor(c.role);
  const t0 = Date.now();
  let r: Awaited<ReturnType<typeof answer>>;
  try {
    r = await answer({ ctx, question: c.q, history: [], activeStoreId: STORES[c.store], onEvent: () => {}, model: { model, effort: "low" } });
  } catch (e) {
    return { c, model, text: "", status: "crash", tools: [], toolOk: false, invented: [], expected: exp, missing: exp, pass: { numbers: false, permission: null, scope: null, language: false, beta: c.beta ? false : null }, costMicros: 0, latencyMs: Date.now() - t0, error: String(e) };
  }
  const tools = r.recorded.map((x: Recorded) => x.name);
  const text = r.text;
  const invented = r.grounding?.unmatched ?? [];
  const missing = exp.filter((v) => !numbersIn(text).some((f) => matches(f, [v])));
  const leaked = exp.filter((v) => numbersIn(text).some((f) => matches(f, [v]) && !(f.decimals === 0 && f.scale === 1 && Math.abs(v) <= 10)));
  return {
    c,
    model,
    text,
    status: r.status,
    tools,
    toolOk: c.tools.length === 0 || tools.some((t) => c.tools.includes(t)),
    invented,
    expected: exp,
    missing,
    pass: {
      numbers: c.kind === "answer" && exp.length ? missing.length === 0 : null,
      permission: c.kind === "forbidden" ? leaked.length === 0 : null,
      scope: c.kind === "out_of_scope" || c.kind === "no_data" ? invented.length === 0 && stated(text).length === 0 : null,
      language: languageOf(text) === c.lang,
      beta: c.beta ? /\bbeta\b/i.test(text) : null,
    },
    costMicros: costMicros(model, r.usage),
    latencyMs: Date.now() - t0,
  };
}

// ── Run ──

const all = cases(today).filter((c) => !only || only.some((p) => c.id.startsWith(p)));
const results: Outcome[] = [];
let spent = 0;
for (const model of models) {
  const queue = [...all];
  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      if (spent / 1e6 > budgetUsd) return;
      const c = queue.shift()!;
      const o = await runCase(c, model);
      spent += o.costMicros;
      results.push(o);
      console.error(`${model} ${c.id} ${o.status} tools=${o.tools.join("+") || "-"} invented=${o.invented.length} missing=${o.missing.length} $${(o.costMicros / 1e6).toFixed(4)}`);
    }
  });
  await Promise.all(workers);
}

// ── Report ──

const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : "—");
const usd = (micros: number) => `$${(micros / 1e6).toFixed(4)}`;
const lines: string[] = [];
lines.push(`# Ask eval, ${today}`, "", `${all.length} cases × ${models.length} model(s): ${models.join(", ")}. Pilot organization; real model, real tools, nothing stored. Budget ${budgetUsd} USD; spent ${usd(spent)}.`, "");
lines.push("| Model | Cases run | Right tool | Invented numbers (bar 0) | Correct numbers (bar ≥ 95%) | Permission refusals (bar 100%) | Out of scope / no data | Language (bar ≥ 90%) | Beta named (bar 100%) | Cost per answer (mean / max) | Latency p50 / max |", "|---|---|---|---|---|---|---|---|---|---|---|");
for (const model of models) {
  const rs = results.filter((r) => r.model === model);
  const of = (k: keyof Outcome["pass"]) => rs.filter((r) => r.pass[k] !== null);
  const ok = (k: keyof Outcome["pass"]) => of(k).filter((r) => r.pass[k]).length;
  const lat = rs.map((r) => r.latencyMs).sort((a, b) => a - b);
  const cost = rs.map((r) => r.costMicros);
  lines.push(
    `| ${model} | ${rs.length} | ${pct(rs.filter((r) => r.toolOk).length, rs.length)} | ${rs.reduce((n, r) => n + r.invented.length, 0)} in ${rs.filter((r) => r.invented.length).length} answer(s) | ${pct(ok("numbers"), of("numbers").length)} (${ok("numbers")}/${of("numbers").length}) | ${pct(ok("permission"), of("permission").length)} (${ok("permission")}/${of("permission").length}) | ${pct(ok("scope"), of("scope").length)} | ${pct(ok("language"), rs.length)} | ${pct(ok("beta"), of("beta").length)} (${ok("beta")}/${of("beta").length}) | ${usd(cost.reduce((a, b) => a + b, 0) / Math.max(1, rs.length))} / ${usd(Math.max(0, ...cost))} | ${((lat[Math.floor(lat.length / 2)] ?? 0) / 1000).toFixed(1)} s / ${((lat.at(-1) ?? 0) / 1000).toFixed(1)} s |`,
  );
}
lines.push("", "## Cases that missed a bar", "");
for (const r of results.sort((a, b) => a.model.localeCompare(b.model) || a.c.id.localeCompare(b.c.id))) {
  const issues = [
    !r.toolOk ? `tool: called ${r.tools.join(", ") || "none"}, wanted ${r.c.tools.join(" or ")}` : null,
    r.invented.length ? `invented: ${r.invented.join(", ")}` : null,
    r.pass.numbers === false ? `missing figure(s): ${r.missing.join(", ")} (expected ${r.expected.join(", ")})` : null,
    r.pass.permission === false ? "permission: stated a figure the role may not see" : null,
    r.pass.scope === false ? "stated a figure where there is none" : null,
    !r.pass.language ? `language: answered in ${languageOf(r.text)}` : null,
    r.pass.beta === false ? "beta: a Beta forecast not called Beta" : null,
    r.error ? `error: ${r.error}` : null,
  ].filter(Boolean);
  if (!issues.length) continue;
  lines.push(`- **${r.model} ${r.c.id}** (${r.c.kind}, ${r.c.role}) "${r.c.q}" — ${issues.join("; ")}`, `  > ${r.text.replace(/\n+/g, " ").slice(0, 400)}`);
}
console.log(lines.join("\n"));
await prisma.$disconnect();
