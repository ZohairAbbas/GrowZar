import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Turn } from "./llm.server";
import type { AskContext, ToolResult } from "./types";

// ── An in-memory database for the ask tables ──

type Row = Record<string, unknown>;
const db = { settings: new Map<string, Row>(), usage: new Map<string, Row>(), conversations: [] as Row[], messages: [] as Row[] };
let ids = 0;
vi.mock("../db.server", () => ({
  prisma: {
    // The cap reservation: an upsert that adds only if the month stays under the cap.
    $queryRaw: async (strings: TemplateStringsArray, organizationId: string, month: string, add: bigint, cap: bigint) => {
      void strings;
      const k = `${organizationId}:${month}`;
      const row = db.usage.get(k);
      if (!row) {
        db.usage.set(k, { organizationId, month, questions: 0, inputTokens: 0n, cachedTokens: 0n, outputTokens: 0n, costMicros: add });
        return [{ costMicros: add }];
      }
      if ((row.costMicros as bigint) + add > cap) return [];
      row.costMicros = (row.costMicros as bigint) + add;
      return [{ costMicros: row.costMicros }];
    },
    askSettings: { findUnique: async ({ where }: { where: { organizationId: string } }) => db.settings.get(where.organizationId) ?? null },
    askUsageMonthly: {
      findUnique: async ({ where }: { where: { organizationId_month: { organizationId: string; month: string } } }) =>
        db.usage.get(`${where.organizationId_month.organizationId}:${where.organizationId_month.month}`) ?? null,
      update: async ({ where, data }: { where: { organizationId_month: { organizationId: string; month: string } }; data: Record<string, { increment: number | bigint }> }) => {
        const row = db.usage.get(`${where.organizationId_month.organizationId}:${where.organizationId_month.month}`)!;
        for (const [f, v] of Object.entries(data)) row[f] = (row[f] as bigint | number) + (v.increment as never);
      },
    },
    askConversation: {
      findFirst: async ({ where }: { where: Row }) => db.conversations.find((c) => c.id === where.id && c.organizationId === where.organizationId && c.userId === where.userId) ?? null,
      create: async ({ data }: { data: Row }) => {
        const c = { id: `conv${++ids}`, ...data };
        db.conversations.push(c);
        return c;
      },
    },
    askMessage: {
      findMany: async ({ where }: { where: { conversationId: string } }) => db.messages.filter((m) => m.conversationId === where.conversationId && m.text !== null).reverse(),
      create: async ({ data }: { data: Row }) => {
        const m = { id: `msg${++ids}`, createdAt: new Date(), ...data };
        db.messages.push(m);
        return m;
      },
      updateMany: async ({ where, data }: { where: { createdAt: { lt: Date } }; data: Row }) => {
        const hit = db.messages.filter((m) => (m.createdAt as Date) < where.createdAt.lt && !m.redactedAt);
        for (const m of hit) Object.assign(m, { text: data.text, toolCalls: null, checks: null, redactedAt: data.redactedAt });
        return { count: hit.length };
      },
    },
  },
}));

// ── A scripted model and recorded tools ──

const turns: Array<(input: unknown[], allowTools: boolean) => Partial<Turn> | Promise<Partial<Turn>>> = [];
const seen: Array<{ inputLength: number; allowTools: boolean }> = [];
vi.mock("./llm.server", async (orig) => {
  const real = await orig<typeof import("./llm.server")>();
  return {
    ...real,
    runTurn: async (o: { input: unknown[]; allowTools: boolean; onText?: (d: string) => void; signal?: AbortSignal }) => {
      seen.push({ inputLength: o.input.length, allowTools: o.allowTools });
      const step = turns.shift();
      if (!step) throw new Error("no scripted turn");
      const t = { text: "", refusal: null, calls: [], items: [], usage: { inputTokens: 1000, cachedTokens: 800, outputTokens: 100, reasoningTokens: 0 }, incomplete: null, ...(await step(o.input, o.allowTools)) };
      if (t.text) o.onText?.(t.text);
      return t;
    },
  };
});
const toolRuns: Array<{ name: string; args: unknown }> = [];
vi.mock("./registry.server", () => ({
  toolSpecs: () => [],
  runTool: async (name: string, args: unknown): Promise<ToolResult> => {
    toolRuns.push({ name, args });
    return { tool: name, status: "ok", title: "t", columns: [{ key: "orders", label: "Orders", kind: "count" }], rows: [{ orders: 42 }], meta: { stores: [], rules: [], gaps: [], notes: [] }, link: null };
  },
}));

const { ask, gate, redactOldMessages, MAX_ROUNDS } = await import("./loop.server");
const { costMicros } = await import("./llm.server");

const ctx = (): AskContext => ({
  organizationId: "org",
  userId: "u1",
  baseCurrency: "PKR",
  stores: [{ id: "s1", name: "Shop", currency: "PKR", timezone: "Asia/Karachi" }],
  can: () => true,
  now: new Date("2026-10-19T10:00:00Z"),
  memo: new Map(),
});
const call = (name: string, args: unknown, callId = "c1") => ({ calls: [{ callId, name, arguments: JSON.stringify(args) }] });

async function run(question = "How many orders?", o: Partial<Parameters<typeof ask>[0]> = {}) {
  const events: Array<{ type: string } & Record<string, unknown>> = [];
  const r = await ask({ ctx: ctx(), question, conversationId: null, activeStoreId: "s1", onEvent: (e) => events.push(e), ...o });
  return { ...r, events };
}

beforeEach(() => {
  process.env.ASK_ENABLED = "on";
  delete process.env.ASK_MODEL;
  db.settings.set("org", { organizationId: "org", enabled: true, monthlyCapMicros: 5_000_000n });
  db.usage.clear();
  db.conversations.length = 0;
  db.messages.length = 0;
  turns.length = 0;
  seen.length = 0;
  toolRuns.length = 0;
});
afterEach(() => {
  delete process.env.ASK_ENABLED;
});

describe("gates", () => {
  it("is off without ASK_ENABLED, whatever the organization says", async () => {
    delete process.env.ASK_ENABLED;
    expect(await gate("org", new Date())).toBe("disabled");
    const r = await run();
    expect(r.status).toBe("disabled");
    expect(seen).toEqual([]);
    expect(db.messages).toEqual([]);
  });

  it("is off until the organization turns it on, unless a script asks past the switch", async () => {
    db.settings.delete("org");
    expect(await gate("org", new Date())).toBe("disabled");
    expect(await gate("org", new Date(), { ignoreOrgSwitch: true })).toBeNull();
  });

  it("stops at the month's cap, before calling the model", async () => {
    db.usage.set("org:2026-10", { costMicros: 5_000_000n });
    const r = await run();
    expect(r.status).toBe("limit");
    expect(r.text).toMatch(/limit/);
    expect(seen).toEqual([]);
  });
});

describe("the loop", () => {
  it("runs the tools the model calls, numbers their tables, and answers", async () => {
    turns.push(() => ({ ...call("summary", { store: "s1", period: null }), text: "" }));
    turns.push((input) => {
      // The tool's output went back to the model, with its table number.
      const out = input.at(-1) as { type: string; output: string };
      expect(out.type).toBe("function_call_output");
      expect(JSON.parse(out.output)).toMatchObject({ table: 1, tool: "summary", rows: [{ orders: 42 }] });
      return { text: "You had 42 orders (table 1)." };
    });
    const r = await run();
    expect(r.status).toBe("answered");
    expect(r.text).toBe("You had 42 orders (table 1).");
    expect(toolRuns).toEqual([{ name: "summary", args: { store: "s1", period: null } }]);
    expect(r.events.map((e) => e.type)).toEqual(["start", "tool", "text", "done"]);
    const answer = db.messages.find((m) => m.role === "assistant")!;
    expect(answer).toMatchObject({ status: "answered", text: r.text, toolResultRefs: ["summary"], inputTokens: 2000, cachedTokens: 1600, outputTokens: 200 });
    expect((answer.toolCalls as unknown[]).length).toBe(1);
    expect(db.messages.find((m) => m.role === "user")!.text).toBe("How many orders?");
  });

  it("counts every model call's cost against the month", async () => {
    turns.push(() => ({ text: "No tools needed." }));
    await run();
    const usage = db.usage.get("org:2026-10")!;
    expect(usage.questions).toBe(1);
    // The reservation is settled to exactly what was spent.
    expect(usage.costMicros).toBe(BigInt(costMicros("gpt-6.1-sol", { inputTokens: 1000, cachedTokens: 800, outputTokens: 100, reasoningTokens: 0 })));
  });

  it("holds a share of the cap for each question in flight, so a burst can't pass it together", async () => {
    db.usage.set("org:2026-10", { organizationId: "org", month: "2026-10", questions: 0, inputTokens: 0n, cachedTokens: 0n, outputTokens: 0n, costMicros: 4_920_000n });
    // Room for one reservation of 50,000 under the 5,000,000 cap, not two.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    turns.push(async () => {
      await held;
      return { text: "Done." };
    });
    const first = run("One?");
    await new Promise((r) => setTimeout(r, 10));
    const second = await run("Two?");
    expect(second.status).toBe("limit");
    release();
    expect((await first).status).toBe("answered");
  });

  it("says when an answer was cut short", async () => {
    turns.push(() => ({ text: "Lahore was", incomplete: "max_output_tokens" }));
    const r = await run();
    expect(r.text).toBe("Lahore was\n\n(This answer was cut short.)");
  });

  it(`stops calling tools after ${MAX_ROUNDS} model calls: the last may only answer`, async () => {
    for (let i = 1; i < MAX_ROUNDS; i++) turns.push(() => call("summary", { store: "s1", period: null }, `c${i}`));
    turns.push((_input, allowTools) => {
      expect(allowTools).toBe(false);
      return { text: "Here is what I found." };
    });
    const r = await run();
    expect(r.status).toBe("answered");
    expect(seen.map((s) => s.allowTools)).toEqual([true, true, true, true, true, false]);
  });

  it("rejects tool arguments that are not JSON without running anything", async () => {
    turns.push(() => ({ calls: [{ callId: "c1", name: "summary", arguments: "{oops" }] }));
    turns.push((input) => {
      expect(JSON.parse((input.at(-1) as { output: string }).output)).toMatchObject({ status: "invalid" });
      return { text: "Sorry." };
    });
    await run();
    expect(toolRuns).toEqual([]);
  });

  it("answers a refusal with Growzar's own words", async () => {
    turns.push(() => ({ refusal: "I can't help with that." }));
    const r = await run("Write me a poem");
    expect(r.status).toBe("refused");
    expect(r.text).toMatch(/orders, deliveries/);
  });

  it("gives up after the overall timeout and records it", async () => {
    vi.useFakeTimers();
    turns.push(
      () =>
        new Promise((_resolve, reject) => {
          setTimeout(() => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), 61_000);
        }),
    );
    const p = run();
    await vi.advanceTimersByTimeAsync(61_000);
    const r = await p;
    vi.useRealTimers();
    expect(r.status).toBe("timeout");
    expect(db.messages.find((m) => m.role === "assistant")!.status).toBe("timeout");
    // The call that broke off is billed; its whole reservation stays counted.
    expect(db.usage.get("org:2026-10")!.costMicros).toBe(50_000n);
  });

  it("continues the member's own conversation with its earlier text, and starts a new one otherwise", async () => {
    turns.push(() => ({ text: "First answer." }));
    const first = await run("First?");
    const conv = first.events[0]!.conversationId as string;
    turns.push((input) => {
      expect(input).toHaveLength(3);
      expect(input[0]).toMatchObject({ role: "user", content: "First?" });
      expect(input[1]).toMatchObject({ role: "assistant", content: "First answer." });
      return { text: "Second answer." };
    });
    await run("Second?", { conversationId: conv });
    // Someone else's conversation id starts a new one.
    turns.push((input) => {
      expect(input).toHaveLength(1);
      return { text: "Fresh." };
    });
    const other = await run("Third?", { conversationId: conv, ctx: { ...ctx(), userId: "u2" } });
    expect(other.events[0]!.conversationId).not.toBe(conv);
  });
});

describe("retention", () => {
  it("clears text and tool results past 90 days and keeps the rest", async () => {
    db.messages.push(
      { id: "old", role: "assistant", text: "old answer", toolCalls: [{}], feedback: "up", costMicros: 10n, createdAt: new Date("2026-07-01T00:00:00Z"), redactedAt: null },
      { id: "new", role: "assistant", text: "new answer", toolCalls: [{}], createdAt: new Date("2026-10-01T00:00:00Z"), redactedAt: null },
    );
    expect(await redactOldMessages(new Date("2026-10-19T00:00:00Z"))).toBe(1);
    expect(db.messages[0]).toMatchObject({ text: null, toolCalls: null, checks: null, feedback: "up", costMicros: 10n });
    expect(db.messages[1]).toMatchObject({ text: "new answer" });
  });
});
