/**
 * Acting on an insight (G-GZR3-3): what a dismiss, snooze or reopen may say,
 * and where a card's link may send the browser. Pure, so the cards import
 * the reasons from here rather than keep a copy.
 */

export const DISMISS_REASONS = {
  wrong: "It's wrong",
  already_knew: "I already knew",
  not_relevant: "Not relevant to us",
  other: "Something else",
} as const;
export type DismissReason = keyof typeof DISMISS_REASONS;
export const SNOOZE_DAYS = [7, 30] as const;

export type InsightAction =
  | { intent: "dismiss"; reason: DismissReason; note: string | null }
  | { intent: "snooze"; days: (typeof SNOOZE_DAYS)[number] }
  | { intent: "reopen" };

export function parseInsightAction(form: FormData): InsightAction | null {
  const intent = form.get("intent");
  if (intent === "reopen") return { intent };
  if (intent === "snooze") {
    const days = Number(form.get("days"));
    return (SNOOZE_DAYS as readonly number[]).includes(days) ? { intent, days: days as 7 | 30 } : null;
  }
  if (intent === "dismiss") {
    const reason = form.get("reason");
    if (typeof reason !== "string" || !Object.hasOwn(DISMISS_REASONS, reason)) return null;
    const note = form.get("note");
    return { intent, reason: reason as DismissReason, note: typeof note === "string" && note.trim() ? note.trim().slice(0, 500) : null };
  }
  return null;
}

/**
 * Where a card's link may send the browser: a path inside this app, never
 * another site (`//evil.example` or `/\evil.example` are both off-site).
 */
export function safeAppPath(to: string | null): string | null {
  if (!to || !to.startsWith("/") || to.startsWith("//") || to.includes("\\")) return null;
  try {
    const u = new URL(to, "http://app.invalid");
    return u.origin === "http://app.invalid" ? `${u.pathname}${u.search}` : null;
  } catch {
    return null;
  }
}
