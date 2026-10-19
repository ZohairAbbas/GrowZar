import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";

import { prisma } from "../db.server";
import { localDayOf } from "../metrics/order-grain";
import { addUsage, askModel, assistantItem, costMicros, LlmError, NO_USAGE, runTurn, toolOutputItem, userItem, type Item, type Usage } from "./llm.server";
import { ground, sourceNumbers, type Grounding } from "./grounding";
import { INSTRUCTIONS, userTurn } from "./prompt";
import { runTool, toolSpecs } from "./registry.server";
import type { AskContext, ToolResult } from "./types";

/**
 * One question, start to finish (Phase 10, G-GZR10-2): the gates, then the
 * model and the tools in turns until it answers, then the record.
 *
 *   gates   kill switch (ASK_ENABLED), the organization's switch, the month's cap
 *   loop    model → tool calls → tools (through runTool) → model …, at most
 *           MAX_ROUNDS model calls; the last one may not call tools
 *   record  the question, the answer, every tool result it drew on, tokens,
 *           cost and time; the month's usage
 *
 * Events stream to the caller as they happen, so the screen shows the answer
 * as it is written and each table as its tool returns.
 */

export const MAX_ROUNDS = 6;
export const TIMEOUT_MS = 60_000;
/** Earlier turns of the conversation sent with a question (text only; tools are called again). */
export const HISTORY_MESSAGES = 8;

export type AskStatus = "answered" | "refused" | "limit" | "rate_limited" | "disabled" | "timeout" | "cancelled" | "error";

export type AskEvent =
  | { type: "start"; conversationId: string }
  /**
   * Text of model call `round`, as it is written; a later round's text
   * replaces an earlier one's. `done.text` is the answer as checked, and
   * replaces whatever streamed (a sentence with an unmatched number is gone).
   */
  | { type: "text"; round: number; delta: string }
  | { type: "tool"; table: number; name: string; args: unknown; result: ToolResult }
  | { type: "done"; messageId: string | null; status: AskStatus; text: string; grounded: boolean | null; usage: Usage; costMicros: number; latencyMs: number };

/** "on", "true" or "1" turns the feature on; anything else, including absent, is off. */
export const askEnabled = () => ["on", "true", "1"].includes((process.env.ASK_ENABLED ?? "").trim().toLowerCase());

export const monthOf = (d: Date) => d.toISOString().slice(0, 7);

/** Questions one person may ask in an hour, across their conversations (G-GZR10-4, agreed 2026-10-19). */
export const RATE_LIMIT_PER_HOUR = 30;

const MESSAGES: Record<Exclude<AskStatus, "answered">, string> = {
  disabled: "Asking about your data isn't turned on for this organization.",
  rate_limited: `That's a lot of questions in an hour. Try again in a little while (the limit is ${RATE_LIMIT_PER_HOUR} an hour per person).`,
  limit: "Your organization has reached this month's limit for questions. It resets on the 1st; an owner can see the usage in Settings → Ask.",
  refused: "I can't help with that one. Ask about your orders, deliveries, couriers, cash, stock, customers or marketing.",
  cancelled: "The question was stopped before it was answered.",
  timeout: "That took too long to answer. Try a narrower question, for one store or a shorter period.",
  error: "Something went wrong while answering. Try again in a moment.",
};

/** Why a question can't be asked now, or null when it can. */
export async function gate(
  organizationId: string,
  userId: string,
  now: Date,
  opts: { ignoreOrgSwitch?: boolean; ignoreRateLimit?: boolean } = {},
): Promise<"disabled" | "limit" | "rate_limited" | null> {
  if (!askEnabled()) return "disabled";
  const [settings, usage, lastHour] = await Promise.all([
    prisma.askSettings.findUnique({ where: { organizationId } }),
    prisma.askUsageMonthly.findUnique({ where: { organizationId_month: { organizationId, month: monthOf(now) } } }),
    opts.ignoreRateLimit
      ? 0
      : prisma.askMessage.count({ where: { role: "user", createdAt: { gte: new Date(now.getTime() - 3_600_000) }, conversation: { organizationId, userId } } }),
  ]);
  if (!opts.ignoreOrgSwitch && !settings?.enabled) return "disabled";
  const cap = settings?.monthlyCapMicros ?? 5_000_000n;
  if ((usage?.costMicros ?? 0n) >= cap) return "limit";
  if (lastHour >= RATE_LIMIT_PER_HOUR) return "rate_limited";
  return null;
}

/**
 * Held against the month's cap before the model is called, then settled to
 * what the answer cost. Parallel questions each hold their share, so a burst
 * cannot pass the cap together; a typical answer costs $0.003–0.016 (eval,
 * 2026-10-19).
 */
export const RESERVE_MICROS = 50_000n;

/** Hold RESERVE_MICROS of the month, atomically, if it fits under the cap. */
async function reserve(organizationId: string, month: string, cap: bigint): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ costMicros: bigint }>>`
    INSERT INTO ask_usage_monthly ("organizationId", month, "costMicros")
    VALUES (${organizationId}, ${month}, ${RESERVE_MICROS})
    ON CONFLICT ("organizationId", month) DO UPDATE
      SET "costMicros" = ask_usage_monthly."costMicros" + EXCLUDED."costMicros"
      WHERE ask_usage_monthly."costMicros" + EXCLUDED."costMicros" <= ${cap}
    RETURNING "costMicros"`;
  return rows.length > 0 && RESERVE_MICROS <= cap;
}

type Recorded = { name: string; args: unknown; table: number; result: ToolResult };

export async function ask(opts: {
  ctx: AskContext;
  question: string;
  conversationId: string | null;
  activeStoreId: string | null;
  onEvent: (e: AskEvent) => void;
  /** Scripts only (the eval): ask without the organization's switch being on, and past the hourly limit. The kill switch and the cap still apply. */
  ignoreOrgSwitch?: boolean;
  signal?: AbortSignal;
}): Promise<{ status: AskStatus; text: string; messageId: string | null }> {
  const { ctx, onEvent } = opts;
  const started = Date.now();
  const question = opts.question.trim().slice(0, 2_000);
  const finish = (status: AskStatus, text: string, messageId: string | null, usage = NO_USAGE, cost = 0) => {
    onEvent({ type: "done", messageId, status, text, grounded: null, usage, costMicros: cost, latencyMs: Date.now() - started });
    return { status, text, messageId };
  };

  const blocked = await gate(ctx.organizationId, ctx.userId, ctx.now, { ignoreOrgSwitch: opts.ignoreOrgSwitch, ignoreRateLimit: opts.ignoreOrgSwitch });
  if (blocked) return finish(blocked, MESSAGES[blocked], null);
  const { model, effort } = askModel();
  const cap = (await prisma.askSettings.findUnique({ where: { organizationId: ctx.organizationId }, select: { monthlyCapMicros: true } }))?.monthlyCapMicros ?? 5_000_000n;
  if (!(await reserve(ctx.organizationId, monthOf(ctx.now), cap))) return finish("limit", MESSAGES.limit, null);

  // The conversation: the member's own, in this organization, or a new one.
  const existing = opts.conversationId
    ? await prisma.askConversation.findFirst({ where: { id: opts.conversationId, organizationId: ctx.organizationId, userId: ctx.userId } })
    : null;
  const conversation =
    existing ?? (await prisma.askConversation.create({ data: { organizationId: ctx.organizationId, userId: ctx.userId, storeIds: ctx.stores.map((s) => s.id) } }));
  onEvent({ type: "start", conversationId: conversation.id });
  const history = existing
    ? (
        await prisma.askMessage.findMany({
          where: { conversationId: conversation.id, text: { not: null }, OR: [{ role: "user" }, { status: "answered" }] },
          orderBy: { createdAt: "desc" },
          take: HISTORY_MESSAGES,
          select: { role: true, text: true },
        })
      ).reverse()
    : [];
  await prisma.askMessage.create({ data: { conversationId: conversation.id, role: "user", text: question } });

  const tz = ctx.stores.find((s) => s.id === opts.activeStoreId)?.timezone ?? ctx.stores[0]?.timezone ?? "UTC";
  const input: Item[] = [
    ...history.map((m) => (m.role === "user" ? userItem(m.text!) : assistantItem(m.text!))),
    userItem(userTurn(ctx, question, opts.activeStoreId, localDayOf(ctx.now, tz))),
  ];
  const tools = toolSpecs();
  const safetyId = createHash("sha256").update(`growzar:${ctx.userId}`).digest("hex").slice(0, 32);

  // One deadline for the whole answer, joined to the caller's (a closed tab).
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout.signal]) : timeout.signal;

  let usage = NO_USAGE;
  let text = "";
  let status: AskStatus = "answered";
  const recorded: Recorded[] = [];
  // `calculate` reads the answer's earlier tables from here.
  ctx.tables = [];
  try {
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      const turn = await runTurn({
        model,
        effort,
        instructions: INSTRUCTIONS,
        input,
        tools,
        allowTools: round < MAX_ROUNDS,
        safetyId,
        signal,
        onText: (delta) => onEvent({ type: "text", round, delta }),
      });
      usage = addUsage(usage, turn.usage);
      input.push(...turn.items);
      text = turn.text;
      // Cut off by the output limit or a filter: say so rather than pass a half answer as whole.
      if (turn.incomplete && !turn.calls.length) {
        if (text.trim()) text = `${text.trim()}\n\n(This answer was cut short.)`;
        break;
      }
      if (turn.refusal) {
        status = "refused";
        text = MESSAGES.refused;
        break;
      }
      if (!turn.calls.length) break;
      // Tools run one after another: they share the question's memo, so a second call about the same store and period loads nothing again.
      for (const call of turn.calls) {
        let args: unknown = null;
        let result: ToolResult;
        try {
          args = JSON.parse(call.arguments);
          result = await runTool(call.name, args, ctx);
        } catch {
          result = { tool: call.name, status: "invalid", title: "The arguments were not valid JSON.", columns: [], rows: [], meta: { stores: [], rules: [], gaps: [], notes: [] }, link: null };
        }
        const table = recorded.length + 1;
        recorded.push({ name: call.name, args, table, result });
        ctx.tables.push(result);
        onEvent({ type: "tool", table, name: call.name, args, result });
        input.push(toolOutputItem(call.callId, JSON.stringify({ table, ...result })));
      }
    }
    if (!text.trim() && status === "answered") {
      status = "error";
      text = MESSAGES.error;
    }
  } catch (e) {
    const err = e instanceof LlmError ? e : new LlmError("failed", e instanceof Error ? e.message : String(e));
    // However the failure surfaced, a passed deadline is a timeout.
    status = opts.signal?.aborted ? "cancelled" : err.kind === "timeout" || timeout.signal.aborted ? "timeout" : "error";
    text = MESSAGES[status];
    console.error(`[ask] ${status}: ${err.kind} ${err.status ?? ""} ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  // Every number in the answer must be one a tool returned (or the question or context gave).
  let grounding: Grounding | null = null;
  if (status === "answered") {
    grounding = ground(text, sourceNumbers(recorded.map((r) => r.result), [question, localDayOf(ctx.now, tz)]));
    if (!grounding.grounded) {
      text = grounding.text;
      console.warn(`[ask] ungrounded answer in conversation ${conversation.id}: ${grounding.unmatched.join(", ")}`);
    }
  } else if (status === "refused") {
    console.warn(`[ask] refused in conversation ${conversation.id}`);
  }

  const cost = costMicros(model, usage);
  const latencyMs = Date.now() - started;
  const message = await prisma.askMessage.create({
    data: {
      conversationId: conversation.id,
      role: "assistant",
      text,
      status,
      model,
      toolCalls: recorded as unknown as Prisma.InputJsonValue,
      toolResultRefs: [...new Set(recorded.map((r) => r.name))],
      grounded: grounding ? grounding.grounded : null,
      checks: grounding && !grounding.grounded ? { unmatched: grounding.unmatched, dropped: grounding.dropped } : undefined,
      inputTokens: usage.inputTokens,
      cachedTokens: usage.cachedTokens,
      outputTokens: usage.outputTokens,
      reasoningTokens: usage.reasoningTokens,
      costMicros: BigInt(cost),
      latencyMs,
    },
  });
  // Settle the reservation to what was spent. An answer that broke off mid-call
  // keeps the whole reservation: the provider bills that call, and its usage never came back.
  const spent = status === "timeout" || status === "error" || status === "cancelled" ? (BigInt(cost) > RESERVE_MICROS ? BigInt(cost) : RESERVE_MICROS) : BigInt(cost);
  await prisma.askUsageMonthly.update({
    where: { organizationId_month: { organizationId: ctx.organizationId, month: monthOf(ctx.now) } },
    data: {
      questions: { increment: 1 },
      inputTokens: { increment: BigInt(usage.inputTokens) },
      cachedTokens: { increment: BigInt(usage.cachedTokens) },
      outputTokens: { increment: BigInt(usage.outputTokens) },
      costMicros: { increment: spent - RESERVE_MICROS },
    },
  });
  onEvent({ type: "done", messageId: message.id, status, text, grounded: grounding?.grounded ?? null, usage, costMicros: cost, latencyMs });
  return { status, text, messageId: message.id };
}

// ── Retention (B6) ─────────────────────────────────────────────────────────

export const RETENTION_DAYS = 90;

/**
 * Questions and answers older than RETENTION_DAYS lose their text and tool
 * results; tokens, cost, status and feedback stay. Idempotent: the worker
 * runs it every hour.
 */
export async function redactOldMessages(now = new Date()): Promise<number> {
  const before = new Date(now.getTime() - RETENTION_DAYS * 86_400_000);
  const r = await prisma.askMessage.updateMany({
    where: { createdAt: { lt: before }, redactedAt: null },
    // `checks` holds the dropped sentences: answer text too.
    data: { text: null, toolCalls: Prisma.DbNull, checks: Prisma.DbNull, redactedAt: now },
  });
  return r.count;
}
