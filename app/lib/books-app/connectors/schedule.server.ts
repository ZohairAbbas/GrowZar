import { prisma } from "../../db.server";
import { getBook } from "../../books/books.server";
import type { ConnectorKey } from "../../books/connectors/registry";
import { booksEnabled, booksOn } from "../switch.server";
import { runAdSpend } from "./ad-spend.server";
import { runCourierPayouts } from "./courier-payouts.server";
import { runConnector, type Runner } from "./runs.server";

/**
 * Which connectors the worker runs, and how often (porting guide §4.10): every
 * tick, up to five switched-on connectors whose last run is at least six
 * hours old, longest-waiting first, one after another. Books pages can also
 * run one now.
 */
export const RUNNERS: Partial<Record<ConnectorKey, Runner>> = {
  ad_spend: runAdSpend,
  courierify_payouts: (book, connector) => runCourierPayouts(book, connector),
};

const EVERY_MS = 6 * 60 * 60 * 1000;
const PER_TICK = 5;

export async function runDueConnectors(now = new Date()): Promise<Array<{ key: string; status: string }>> {
  if (!booksEnabled()) return [];
  const due = await prisma.bkConnector.findMany({
    where: { enabled: true, key: { in: Object.keys(RUNNERS) }, OR: [{ lastRunAt: null }, { lastRunAt: { lt: new Date(now.getTime() - EVERY_MS) } }] },
    orderBy: [{ lastRunAt: { sort: "asc", nulls: "first" } }],
    take: PER_TICK,
    select: { key: true, bookId: true },
  });
  const out: Array<{ key: string; status: string }> = [];
  for (const c of due) {
    const row = await prisma.bkBook.findUnique({ where: { id: c.bookId }, select: { organizationId: true } });
    // An organization whose Books is switched off keeps its books but runs nothing.
    if (!row || !(await booksOn(row.organizationId))) continue;
    const book = await getBook(row.organizationId);
    const runner = RUNNERS[c.key as ConnectorKey];
    if (!book || !runner) continue;
    const r = await runConnector(book, c.key as ConnectorKey, "auto", runner);
    if (r) out.push({ key: c.key, status: r.status });
  }
  return out;
}
