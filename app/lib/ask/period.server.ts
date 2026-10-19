import { z } from "zod";

import { customRange } from "../metrics/period";
import { periodFrom } from "../metrics/screens.server";

/**
 * A period as the model asks for it: one of the screens' presets, or a custom
 * range. Resolved by the screens' own `periodFrom`, in each store's timezone,
 * so a link built from it opens the same days.
 */
export const periodArg = z
  .object({
    days: z.union([z.literal(7), z.literal(30), z.literal(60), z.literal(90)]).nullable().describe("A preset ending today: 7, 30, 60 or 90 days. Null when from and to are given."),
    from: z.string().nullable().describe("First day of a custom range, YYYY-MM-DD, in the store's own days."),
    to: z.string().nullable().describe("Last day of a custom range, YYYY-MM-DD. At most 366 days after from."),
  })
  .strict()
  .describe("The period. Null for the last 30 days.");

export type PeriodArg = z.infer<typeof periodArg>;

export type AskPeriod = ReturnType<typeof periodFrom>;

/** The period for one store, or why the arguments do not make one. */
export function resolvePeriod(arg: PeriodArg | null, timezone: string | null, now: Date): AskPeriod | { error: string } {
  const q = new URLSearchParams();
  if (arg?.from || arg?.to) {
    const today = periodFrom(new URL("http://ask/"), timezone, now).today;
    if (!customRange(arg.from, arg.to, today)) {
      return { error: "A custom period needs real days (YYYY-MM-DD), from on or before to and today, at most 366 days long." };
    }
    q.set("from", arg.from!);
    q.set("to", arg.to!);
  } else if (arg?.days) {
    q.set("days", String(arg.days));
  }
  return periodFrom(new URL(`http://ask/?${q}`), timezone, now);
}

export const periodOf = (p: AskPeriod) => ({ from: p.from, to: p.to, days: p.days });
