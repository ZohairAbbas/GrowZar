/**
 * Matching statement lines to the books, and the rules that suggest what an
 * unmatched line is. Pure and browser-safe.
 */

export const MATCH_WINDOW_DAYS = 7;

export interface StatementLineLite {
  id: string;
  date: string;
  amount: bigint;
}

export interface LedgerLineLite {
  id: string;
  date: string;
  amount: bigint;
}

function days(a: string, b: string): number {
  return Math.abs(Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000));
}

/**
 * The best ledger line for each statement line: same amount, dates within a
 * week, closest dates first. A ledger line is offered to one statement line
 * only, so two identical payments pair up one-to-one.
 */
export function suggestMatches(statement: StatementLineLite[], ledger: LedgerLineLite[], windowDays = MATCH_WINDOW_DAYS): Map<string, string> {
  const byAmount = new Map<bigint, LedgerLineLite[]>();
  for (const l of ledger) byAmount.set(l.amount, [...(byAmount.get(l.amount) ?? []), l]);
  const pairs: Array<{ s: StatementLineLite; l: LedgerLineLite; gap: number }> = [];
  for (const s of statement) {
    for (const l of byAmount.get(s.amount) ?? []) {
      const gap = days(s.date, l.date);
      if (gap <= windowDays) pairs.push({ s, l, gap });
    }
  }
  pairs.sort((a, b) => a.gap - b.gap || a.s.date.localeCompare(b.s.date) || a.s.id.localeCompare(b.s.id, undefined, { numeric: true }) || a.l.id.localeCompare(b.l.id, undefined, { numeric: true }));
  const out = new Map<string, string>();
  const used = new Set<string>();
  for (const p of pairs) {
    if (out.has(p.s.id) || used.has(p.l.id)) continue;
    out.set(p.s.id, p.l.id);
    used.add(p.l.id);
  }
  return out;
}

export interface BankRuleLite {
  id: string;
  contains: string;
  direction: "in" | "out";
  accountId: string;
  contactId: string | null;
  /** Only lines whose size is in this range (minor units, positive); null = any. */
  minAmount?: bigint | null;
  maxAmount?: bigint | null;
  /** "account" (an expense / money in, maybe split) or "transfer" (money moved to/from accountId). */
  kind?: string;
  split?: Array<{ accountId: string; percent: number }> | null;
}

/** Words only: numbers, references and punctuation dropped, lower case. */
function words(s: string): string {
  return ` ${s
    .replace(/[0-9][0-9\-/:.]*/g, " ")
    .replace(/[^\p{L}&' ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()} `;
}

/**
 * The rule for a line: the rule's words appear in the description's words
 * (so "IBFT ALI TRADERS" matches "IBFT 0042 ALI TRADERS"); the most specific
 * (longest) rule wins.
 */
export function ruleFor<R extends BankRuleLite>(rules: R[], description: string, amount: bigint): R | null {
  const d = words(description);
  const direction = amount < 0n ? "out" : "in";
  const size = amount < 0n ? -amount : amount;
  const span = (r: R) => (r.minAmount == null && r.maxAmount == null ? null : (r.maxAmount ?? 10n ** 18n) - (r.minAmount ?? 0n));
  let best: R | null = null;
  for (const r of rules) {
    const c = words(r.contains).trim();
    if (!c || r.direction !== direction || !d.includes(` ${c} `)) continue;
    if (r.minAmount != null && size < r.minAmount) continue;
    if (r.maxAmount != null && size > r.maxAmount) continue;
    if (!best) {
      best = r;
      continue;
    }
    const bc = words(best.contains).trim().length;
    // The most specific wins: more words, then a narrower amount range.
    if (c.length > bc) best = r;
    else if (c.length === bc) {
      const a = span(r);
      const b = span(best);
      if (a !== null && (b === null || a < b)) best = r;
    }
  }
  return best;
}

/** Percent (up to 2 decimals) → basis points. */
export const percentToBp = (p: number) => Math.round(p * 100);

/** Split an amount by percentages exactly: rounding goes to the largest share. */
export function splitAmounts(total: bigint, split: Array<{ accountId: string; percent: number }>): Array<{ accountId: string; amount: bigint }> {
  const bps = split.map((x) => BigInt(percentToBp(x.percent)));
  const out = split.map((x, i) => ({ accountId: x.accountId, amount: (total * bps[i]!) / 10000n }));
  const rest = total - out.reduce((s, x) => s + x.amount, 0n);
  if (rest !== 0n && out.length) {
    let big = 0;
    for (let i = 1; i < bps.length; i++) if (bps[i]! > bps[big]!) big = i;
    out[big]!.amount += rest;
  }
  return out.filter((x) => x.amount !== 0n);
}

/** A split adds up to 100% with 2–10 parts, each over 0. Returns a message, or null when fine. */
export function splitProblem(split: Array<{ accountId: string; percent: number }>): string | null {
  if (split.length < 2) return "A split needs at least two accounts";
  if (split.length > 10) return "A split can have at most 10 accounts";
  if (split.some((x) => !x.accountId)) return "Choose an account for every part";
  if (split.some((x) => !(Number.isFinite(x.percent) && x.percent > 0 && x.percent < 100))) return "Each part is a percentage between 0 and 100";
  if (new Set(split.map((x) => x.accountId)).size !== split.length) return "Each account once";
  if (split.reduce((s, x) => s + percentToBp(x.percent), 0) !== 10000) return "The parts must add up to 100%";
  return null;
}

/** Words worth remembering from a description: drops numbers and references so the rule matches next month too. */
export function ruleWordsFrom(description: string): string {
  return description
    .replace(/[0-9][0-9\-/:.]*/g, " ")
    .replace(/[^\p{L}&' ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 4)
    .join(" ")
    .slice(0, 60);
}

/** Reconciling: what's cleared and what's left to find. All amounts in ledger sign. */
export function reconcileFigures(statementBalance: bigint, previouslyCleared: bigint, ticked: bigint[]) {
  const cleared = previouslyCleared + ticked.reduce((s, x) => s + x, 0n);
  return { cleared, difference: statementBalance - cleared };
}

// ── Several at once, close matches, reversals ───────────────────────────────

const abs = (v: bigint) => (v < 0n ? -v : v);

/**
 * A subset (2–`maxSize` items) of `pool` whose amounts add up to `target`
 * exactly, preferring fewer items and then the pool's order (closest dates
 * first). Bounded: at most `maxSize` items from at most 12 candidates.
 */
export function findSubset<T extends { amount: bigint }>(pool: T[], target: bigint, maxSize = 4): T[] | null {
  const items = pool.slice(0, 12);
  for (let size = 2; size <= Math.min(maxSize, items.length); size++) {
    const pick: number[] = [];
    const walk = (start: number, sum: bigint): T[] | null => {
      if (pick.length === size) return sum === target ? pick.map((i) => items[i]!) : null;
      for (let i = start; i < items.length; i++) {
        pick.push(i);
        const r = walk(i + 1, sum + items[i]!.amount);
        pick.pop();
        if (r) return r;
      }
      return null;
    };
    const r = walk(0, 0n);
    if (r) return r;
  }
  return null;
}

export interface GroupSuggestion {
  statementIds: string[];
  ledgerIds: string[];
}

/**
 * Matches that aren't one-to-one, after the exact ones are taken:
 *  - one statement line = several entries (a deposit of two payouts),
 *  - one entry = several statement lines (a payout paid in two transfers).
 * Same direction, dates within the window, nothing used twice.
 */
export function suggestGroups(statement: StatementLineLite[], ledger: LedgerLineLite[], windowDays = MATCH_WINDOW_DAYS): GroupSuggestion[] {
  const usedS = new Set<string>();
  const usedL = new Set<string>();
  const out: GroupSuggestion[] = [];
  const near = <T extends { date: string; amount: bigint; id: string }>(xs: T[], date: string, sign: boolean, used: Set<string>) =>
    xs
      .filter((x) => !used.has(x.id) && x.amount < 0n === sign && x.amount !== 0n && days(x.date, date) <= windowDays)
      .sort((a, b) => days(a.date, date) - days(b.date, date) || a.id.localeCompare(b.id, undefined, { numeric: true }));
  for (const s of [...statement].sort((a, b) => a.date.localeCompare(b.date))) {
    if (usedS.has(s.id)) continue;
    const pool = near(ledger, s.date, s.amount < 0n, usedL);
    const hit = findSubset(pool, s.amount);
    if (hit) {
      out.push({ statementIds: [s.id], ledgerIds: hit.map((h) => h.id) });
      usedS.add(s.id);
      for (const h of hit) usedL.add(h.id);
    }
  }
  for (const l of [...ledger].sort((a, b) => a.date.localeCompare(b.date))) {
    if (usedL.has(l.id)) continue;
    const pool = near(statement, l.date, l.amount < 0n, usedS);
    const hit = findSubset(pool, l.amount);
    if (hit) {
      out.push({ statementIds: hit.map((h) => h.id), ledgerIds: [l.id] });
      usedL.add(l.id);
      for (const h of hit) usedS.add(h.id);
    }
  }
  return out;
}

/** How far a close match may be off: fees, tax withheld, rounding. */
export const CLOSE_MATCH_PERCENT = 5;

export interface CloseSuggestion {
  statementId: string;
  ledgerId: string;
  /** statement − entry: negative = less arrived (or more went out) than the entry says. */
  difference: bigint;
}

/**
 * Entries that are nearly the statement line: same direction, within the
 * window, off by more than nothing and at most CLOSE_MATCH_PERCENT of the
 * line. Smallest difference, then closest date, first; one-to-one.
 */
export function suggestClose(statement: StatementLineLite[], ledger: LedgerLineLite[], windowDays = MATCH_WINDOW_DAYS): CloseSuggestion[] {
  const pairs: Array<CloseSuggestion & { gap: number }> = [];
  for (const s of statement) {
    if (s.amount === 0n) continue;
    const limit = (abs(s.amount) * BigInt(CLOSE_MATCH_PERCENT)) / 100n;
    for (const l of ledger) {
      if (l.amount === 0n || l.amount < 0n !== s.amount < 0n) continue;
      const diff = s.amount - l.amount;
      if (diff === 0n || abs(diff) > limit) continue;
      const gap = days(s.date, l.date);
      if (gap > windowDays) continue;
      pairs.push({ statementId: s.id, ledgerId: l.id, difference: diff, gap });
    }
  }
  pairs.sort((a, b) => (abs(a.difference) < abs(b.difference) ? -1 : abs(a.difference) > abs(b.difference) ? 1 : 0) || a.gap - b.gap || a.statementId.localeCompare(b.statementId, undefined, { numeric: true }));
  const usedS = new Set<string>();
  const usedL = new Set<string>();
  const out: CloseSuggestion[] = [];
  for (const p of pairs) {
    if (usedS.has(p.statementId) || usedL.has(p.ledgerId)) continue;
    usedS.add(p.statementId);
    usedL.add(p.ledgerId);
    out.push({ statementId: p.statementId, ledgerId: p.ledgerId, difference: p.difference });
  }
  return out;
}

/**
 * Lines that cancel each other — a payment and its reversal, a bounced
 * cheque: opposite amounts within 5 days. Ones that say so ("reversal",
 * "return", "bounce", "refund") pair first.
 */
export function reversalPairs(statement: Array<StatementLineLite & { description: string }>): Array<[string, string]> {
  const says = (d: string) => /\b(rev|reversal|reversed|return(ed)?|bounce[d]?|refund(ed)?|unpaid|dishonou?red|cancel(led)?)\b/i.test(d);
  const pairs: Array<{ a: string; b: string; score: number }> = [];
  for (const a of statement) {
    if (a.amount <= 0n) continue;
    for (const b of statement) {
      if (b.amount !== -a.amount) continue;
      const gap = days(a.date, b.date);
      if (gap > 5) continue;
      pairs.push({ a: a.id, b: b.id, score: (says(a.description) || says(b.description) ? 0 : 100) + gap });
    }
  }
  pairs.sort((x, y) => x.score - y.score || x.a.localeCompare(y.a, undefined, { numeric: true }));
  const used = new Set<string>();
  const out: Array<[string, string]> = [];
  for (const p of pairs) {
    if (used.has(p.a) || used.has(p.b)) continue;
    used.add(p.a);
    used.add(p.b);
    out.push([p.b, p.a]); // money out first
  }
  return out;
}

// ── Checks on an import ──────────────────────────────────────────────────────

/**
 * Lines new to this import that look like lines already imported from
 * another file: same date and amount (the description or balance differs,
 * so the exact-key check let them through). Index → the earlier line's id.
 * Each earlier line is used once, so two genuine equal payments in both
 * files pair up rather than all pointing at one.
 */
export function possibleDuplicates(fresh: Array<{ date: string; amount: bigint }>, existing: Array<{ id: string; date: string; amount: bigint }>): Map<number, string> {
  const pool = new Map<string, string[]>();
  for (const e of existing) pool.set(`${e.date}|${e.amount}`, [...(pool.get(`${e.date}|${e.amount}`) ?? []), e.id]);
  const out = new Map<number, string>();
  fresh.forEach((f, i) => {
    const ids = pool.get(`${f.date}|${f.amount}`);
    if (ids && ids.length) out.set(i, ids.shift()!);
  });
  return out;
}

/**
 * The running balance: does each line's balance follow from the one before?
 * Works whichever way the file is sorted. And does the file pick up where
 * the last import left off? Returns plain-words notes (empty = all fine).
 */
export function balanceNotes(lines: Array<{ row: number; date: string; amount: bigint; balance: bigint | null }>, previous: { date: string; balance: bigint } | null, fmt: (v: bigint) => string): string[] {
  const withBal = lines.filter((l) => l.balance !== null);
  if (withBal.length < 2 && !previous) return [];
  const breaks = (xs: typeof withBal) => {
    let n = 0;
    let first: number | null = null;
    for (let i = 1; i < xs.length; i++) {
      if (xs[i - 1]!.balance! + xs[i]!.amount !== xs[i]!.balance) {
        n++;
        first ??= xs[i]!.row;
      }
    }
    return { n, first };
  };
  // Oldest first or newest first, whichever the running balance fits better.
  const forward = breaks(withBal);
  const backward = breaks([...withBal].reverse());
  const ordered = backward.n < forward.n ? [...withBal].reverse() : withBal;
  const b = backward.n < forward.n ? backward : forward;
  const notes: string[] = [];
  if (withBal.length >= 2 && b.n > 0) notes.push(`The running balance doesn't add up at ${b.n} place${b.n === 1 ? "" : "s"} (first at row ${b.first}) — lines may be missing from the file, or the bank sorts same-day lines differently.`);
  if (previous && ordered.length) {
    const first = ordered[0];
    const opening = first!.balance! - first!.amount;
    if (opening !== previous.balance) notes.push(`This file starts from a balance of ${fmt(opening)}, but the last line imported before (${previous.date}) ended at ${fmt(previous.balance)} — some lines between the two files may be missing.`);
  }
  return notes;
}

/** Every date reads both day-first and month-first (03/04/2026): worth a second look. */
export function datesAmbiguous(cells: string[], parse: (c: string, f: "DMY" | "MDY") => string | null): boolean {
  const filled = cells.map((c) => c.trim()).filter(Boolean);
  return filled.length > 0 && filled.every((c) => parse(c, "DMY") !== null && parse(c, "MDY") !== null) && filled.some((c) => parse(c, "DMY") !== parse(c, "MDY"));
}

// ── Scoring: amount, date and words together ────────────────────────────────

/** Words that say nothing about who a line is from. */
const NOISE = new Set(["ibft", "ift", "ft", "fund", "funds", "transfer", "trf", "tfr", "from", "to", "by", "the", "and", "pvt", "ltd", "limited", "private", "co", "company", "inward", "outward", "credit", "debit", "cr", "dr", "payment", "pay", "paid", "online", "mobile", "app", "raast", "cheque", "chq", "clearing", "deposit", "dep", "cash", "atm", "pos", "ref", "no", "txn", "trx", "bank", "account", "acc", "a/c", "mr", "mrs", "ms", "sons", "s/o", "m/s", "enterprises", "traders", "trading", "store", "shop"]);

/** Meaningful words of a description or name: letters only, lower case, noise dropped. */
export function nameTokens(s: string): string[] {
  return [...new Set(
    s
      .toLowerCase()
      .replace(/[^\p{L}\s]+/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !NOISE.has(w)),
  )];
}

/** Edit distance, bounded (stops early past `max`). */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j]! < best) best = cur[j]!;
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length]!;
}

/** Two words are the same allowing a typo (one slip per 5 letters), or one starts the other ("ali" / "alitraders"). */
export function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a))) return true;
  const max = Math.floor(Math.min(a.length, b.length) / 5);
  return max > 0 && editDistance(a, b, max) <= max;
}

/** How much of a name the description mentions: 0..1 (share of the name's words found). */
export function nameMatch(description: string, name: string | null | undefined): number {
  const n = nameTokens(name ?? "");
  if (n.length === 0) return 0;
  const d = nameTokens(description);
  const glued = description.toLowerCase().replace(/[^\p{L}]+/gu, "");
  let found = 0;
  for (const w of n) if (d.some((x) => sameWord(x, w)) || (w.length >= 5 && glued.includes(w))) found++;
  return found / n.length;
}

/** The description mentions an entry's number (INV-0012 as "INV-0012", "INV 12" or "inv0012"). */
export function mentionsNumber(description: string, number: string | null | undefined): boolean {
  const m = /^([A-Z]+)-0*(\d+)$/.exec(number ?? "");
  if (!m) return false;
  return new RegExp(`\\b${m[1]}[\\s\\-#:]*0*${m[2]}\\b`, "i").test(description);
}

export type Strength = "strong" | "likely" | "possible";

export interface ScoredCandidate {
  id: string;
  score: number;
  strength: Strength;
  reasons: string[];
  /** statement − entry (0 = the same amount). */
  difference: bigint;
}

export interface CandidateInfo {
  id: string;
  date: string;
  amount: bigint;
  number?: string | null;
  contactName?: string | null;
  memo?: string | null;
}

/**
 * How well an entry fits a statement line, 0–100, with the reasons in plain
 * words. Amount counts most (exact, or within CLOSE_MATCH_PERCENT for a fee
 * or tax taken off), then the date, then the words: the entry's number in the
 * description, or the contact's name (typos allowed).
 * Same amount + within a week (and no words) is likely; strong needs the
 * name or number too. Strong ≥ 80, likely ≥ 55; below 35 isn't offered.
 */
export function scoreCandidate(line: { date: string; amount: bigint; description: string }, c: CandidateInfo): ScoredCandidate | null {
  if (c.amount === 0n || line.amount === 0n || c.amount < 0n !== line.amount < 0n) return null;
  const reasons: string[] = [];
  let score = 0;
  const difference = line.amount - c.amount;
  const size = line.amount < 0n ? -line.amount : line.amount;
  const off = difference < 0n ? -difference : difference;
  if (off === 0n) {
    score += 50;
    reasons.push("same amount");
  } else if (off * 100n <= size * BigInt(CLOSE_MATCH_PERCENT)) {
    score += 30;
    reasons.push("amount nearly the same");
  } else return null;
  const gap = days(line.date, c.date);
  if (gap > 45) return null;
  const dateScore = gap === 0 ? 20 : gap <= 3 ? 16 : gap <= 7 ? 10 : gap <= 14 ? 4 : 0;
  score += dateScore;
  reasons.push(gap === 0 ? "same day" : `${gap} day${gap === 1 ? "" : "s"} apart`);
  if (mentionsNumber(line.description, c.number)) {
    score += 30;
    reasons.push(`mentions ${c.number}`);
  } else {
    const nm = Math.max(nameMatch(line.description, c.contactName), nameMatch(line.description, c.memo) * 0.8);
    if (nm >= 1) {
      score += 20;
      reasons.push(c.contactName && nameMatch(line.description, c.contactName) >= 1 ? `mentions ${c.contactName}` : "same words");
    } else if (nm >= 0.5) {
      score += 10;
      reasons.push(c.contactName ? `partly mentions ${c.contactName}` : "similar words");
    }
  }
  score = Math.min(100, score);
  if (score < 35) return null;
  return { id: c.id, score, strength: score >= 80 ? "strong" : score >= 55 ? "likely" : "possible", reasons, difference };
}

/**
 * The best entry for each line, one-to-one, highest score first (ties: the
 * smaller difference, then the closer date). Lines left without one keep
 * going to the other suggestions (groups, rules, names).
 */
export function bestMatches(lines: Array<{ id: string; date: string; amount: bigint; description: string }>, candidates: CandidateInfo[]): Map<string, ScoredCandidate> {
  const all: Array<{ line: string; s: ScoredCandidate; gap: number }> = [];
  const byDir = { in: candidates.filter((c) => c.amount > 0n), out: candidates.filter((c) => c.amount < 0n) };
  for (const l of lines) {
    for (const c of l.amount < 0n ? byDir.out : byDir.in) {
      const s = scoreCandidate(l, c);
      if (s) all.push({ line: l.id, s, gap: days(l.date, c.date) });
    }
  }
  all.sort((a, b) => b.s.score - a.s.score || (abs(a.s.difference) < abs(b.s.difference) ? -1 : abs(a.s.difference) > abs(b.s.difference) ? 1 : 0) || a.gap - b.gap || a.line.localeCompare(b.line, undefined, { numeric: true }) || a.s.id.localeCompare(b.s.id, undefined, { numeric: true }));
  const out = new Map<string, ScoredCandidate>();
  const used = new Set<string>();
  for (const x of all) {
    if (out.has(x.line) || used.has(x.s.id)) continue;
    out.set(x.line, x.s);
    used.add(x.s.id);
  }
  return out;
}

/** Contacts a description names, best first (for lines nothing in the books matches). */
export function contactsNamed(description: string, contacts: Array<{ id: string; name: string }>): Array<{ id: string; name: string; match: number }> {
  return contacts
    .map((c) => ({ ...c, match: nameMatch(description, c.name) }))
    .filter((c) => c.match >= 1 || (c.match >= 0.5 && nameTokens(c.name).length >= 2))
    .sort((a, b) => b.match - a.match || nameTokens(b.name).length - nameTokens(a.name).length)
    .slice(0, 3);
}
