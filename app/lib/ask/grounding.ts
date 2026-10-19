import type { ToolResult } from "./types";

/**
 * The guard against invented numbers (pack §4.1, G-GZR10-4). Pure.
 *
 * Before an answer is shown, every number in its text must match a number
 * the turn's tools returned, or one the question or the context gave. A
 * sentence with a number that matches nothing is dropped (the table under the
 * answer still shows the figures), and the answer is recorded as ungrounded.
 *
 * A match allows what writing a number does to it, and nothing else:
 *  - thousands separators, international or South Asian ("1,71,086");
 *  - fewer decimals, rounded or cut (93.25 → "93.3", "93"; 36,877.29 → "36,877");
 *  - a sign written as words ("a loss of PKR 5,173" for −5,173.10);
 *  - k / thousand / lakh / million / crore / billion, at the precision shown
 *    ("PKR 1.7 million" for 1,710,860.20);
 *  - Eastern Arabic and Persian digits (Urdu script).
 * Dates are checked by their parts, and "table N" citations are not figures.
 * A bare whole number up to 10 with no % or decimals is let through: answers
 * count things ("3 products", "two of the 5 couriers"), and such counts are
 * shown in the table beside them.
 */

const SCALES: Record<string, number> = {
  k: 1e3,
  thousand: 1e3,
  hazar: 1e3,
  hazaar: 1e3,
  lakh: 1e5,
  lac: 1e5,
  lakhs: 1e5,
  mn: 1e6,
  million: 1e6,
  crore: 1e7,
  cr: 1e7,
  crores: 1e7,
  bn: 1e9,
  billion: 1e9,
  arab: 1e9,
};

/** ٠١٢٣٤٥٦٧٨٩ and ۰۱۲۳۴۵۶۷۸۹ → 0–9; the Arabic decimal and thousands marks too. */
export function asciiDigits(s: string): string {
  return s
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/٫/g, ".")
    .replace(/٬/g, ",");
}

const DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
const CITATION = /\(?\btables?\s+\d+(?:\s*(?:,|and|aur|&|-|–)\s*\d+)*\)?/gi;
const NUMBER = /(?<![\w#.])([-−]?)(\d{1,3}(?:,\d{2,3})+|\d+)(?:\.(\d+))?(?:\s?(k|thousand|hazaa?r|lakhs?|lac|mn|million|crores?|cr|bn|billion|arab)\b)?(\s?%)?(?:\s?([a-z]+))?/gi;
/** "Rs.5,000", "PKR5000": a currency written against its amount is split off, so the amount is read. */
const CURRENCY_AGAINST = /\b(rs|pkr|aed|usd|inr|sar|eur|gbp|cop)\.?(?=[-−]?\d)/gi;
const CURRENCY_BEFORE = /(?:^|[^a-z])(?:rs|pkr|aed|usd|inr|sar|eur|gbp|cop)\.?\s*$/i;
/** Words after a number that make it a measure, not a count ("6 points", "3 times"). */
const MEASURE = new Set(["points", "point", "pts", "pt", "percent", "fisad", "times", "x", "guna", "gun"]);

export type Found = {
  text: string;
  value: number;
  decimals: number;
  scale: number;
  percent: boolean;
  /** Money or a measure ("PKR 5", "6 points"), never a count. */
  measure: boolean;
};

/** The numbers a text states, with how precisely it states them. */
export function numbersIn(raw: string): Found[] {
  const text = asciiDigits(raw).replace(CITATION, " ").replace(CURRENCY_AGAINST, "$1 ").replace(DATE, (_m, y, mo, d) => ` ${y} ${mo} ${d} `);
  const out: Found[] = [];
  for (const m of text.matchAll(NUMBER)) {
    const [, sign, int, frac, scaleWord, pct, after] = m;
    const scale = scaleWord ? (SCALES[scaleWord.toLowerCase()] ?? 1) : 1;
    const value = Number(`${int!.replace(/,/g, "")}${frac ? `.${frac}` : ""}`) * scale * (sign ? -1 : 1);
    const shown = `${sign ?? ""}${int}${frac ? `.${frac}` : ""}${scaleWord ? ` ${scaleWord}` : ""}${pct ? "%" : ""}`;
    const measure = CURRENCY_BEFORE.test(text.slice(Math.max(0, m.index! - 6), m.index!)) || (after !== undefined && MEASURE.has(after.toLowerCase()));
    out.push({ text: shown, value, decimals: frac?.length ?? 0, scale, percent: Boolean(pct), measure });
  }
  return out;
}

/** Ids and links: numbers in them are not figures (a variant id, a store id, a URL's days=30). */
const NOT_FIGURES = (k: string) => k === "key" || k === "link" || k === "href" || k.endsWith("_key") || k === "id";

/** Every number a set of tool results states, in any field but ids and links, plus their row counts. */
export function sourceNumbers(results: readonly ToolResult[], extra: readonly string[] = []): number[] {
  const out: number[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "number" && Number.isFinite(v)) out.push(v);
    else if (typeof v === "string") for (const f of numbersIn(v)) out.push(f.value);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) if (!NOT_FIGURES(k)) walk(x);
  };
  for (const r of results) {
    walk(r);
    out.push(r.rows.length);
  }
  for (const s of extra) walk(s);
  return out;
}

/**
 * Does the stated number match a source number at the precision it is
 * stated to: the source rounded, or cut (as the screens cut cents), to the
 * digits shown equals it exactly.
 */
export function matches(f: Found, sources: readonly number[]): boolean {
  const per = 10 ** f.decimals / f.scale;
  const t = Math.round(Math.abs(f.value) * per);
  return sources.some((s) => {
    const x = Math.abs(s) * per;
    return Math.round(x) === t || Math.floor(x + 1e-9) === t;
  });
}

const freeCount = (f: Found) => f.decimals === 0 && f.scale === 1 && !f.percent && !f.measure && Math.abs(f.value) <= 10;

export type Grounding = {
  grounded: boolean;
  /** The answer with every sentence that states an unmatched number removed. */
  text: string;
  unmatched: string[];
  dropped: string[];
};

/** Sentences, keeping list items and line breaks as boundaries. */
function sentences(text: string): string[] {
  return text.split(/(?<=[.!?۔])\s+(?=\S)|\n+/).filter((s) => s.trim());
}

export const ALL_DROPPED = "Here are the figures Growzar found; the table below shows them.";

/** The sentence's numbers that match nothing. */
export const unmatchedIn = (sentence: string, sources: readonly number[]) => numbersIn(sentence).filter((f) => !freeCount(f) && !matches(f, sources));

/**
 * The check as text streams: whole sentences go out once their numbers
 * match what the tools have returned so far, and a sentence that doesn't
 * never reaches the screen. `ground` on the full text is the record.
 */
export class StreamCheck {
  private buffer = "";
  constructor(private readonly sources: () => readonly number[]) {}
  /** Text that may be shown now. */
  push(delta: string): string {
    this.buffer += delta;
    // Up to the last sentence end followed by space, or the last line break.
    const cut = Math.max(this.buffer.lastIndexOf("\n") + 1, ...[...this.buffer.matchAll(/[.!?۔](?=\s)/g)].map((m) => m.index! + 1));
    if (cut <= 0) return "";
    const ready = this.buffer.slice(0, cut);
    this.buffer = this.buffer.slice(cut);
    return this.keep(ready);
  }
  /** The rest, at the end of the call. */
  flush(): string {
    const rest = this.buffer;
    this.buffer = "";
    return this.keep(rest);
  }
  private keep(chunk: string): string {
    const sources = this.sources();
    // Keep the chunk's shape: drop failing sentences, keep each line's own spaces and line breaks.
    return chunk.replace(/[^\n]+/g, (line) => {
      const kept = sentences(line)
        .filter((s) => !unmatchedIn(s, sources).length)
        .map((s) => s.trim())
        .join(" ");
      return kept ? `${line.match(/^[ \t]*/)![0]}${kept}${line.match(/[ \t]*$/)![0]}` : "";
    });
  }
}

export function ground(text: string, sources: readonly number[]): Grounding {
  const unmatched: string[] = [];
  const dropped: string[] = [];
  const kept: string[] = [];
  // Rebuild line by line so lists and paragraphs keep their shape.
  for (const line of text.split("\n")) {
    if (!line.trim()) {
      kept.push(line);
      continue;
    }
    const parts = sentences(line);
    const ok = parts.filter((s) => {
      const bad = unmatchedIn(s, sources);
      if (!bad.length) return true;
      unmatched.push(...bad.map((b) => b.text));
      dropped.push(s.trim());
      return false;
    });
    if (ok.length) kept.push(ok.join(" "));
  }
  const out = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { grounded: unmatched.length === 0, text: unmatched.length ? out || ALL_DROPPED : text, unmatched, dropped };
}
