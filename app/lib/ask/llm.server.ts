import OpenAI, { APIError } from "openai";

/**
 * The model provider, and the only module that knows it (Phase 10, B2:
 * OpenAI). Everything provider-specific lives here: the client, the request,
 * streaming, tool calls, usage and price. The loop sees only `runTurn`, the
 * item helpers and `costMicros`, so changing provider is this one file.
 *
 * Requests use the Responses API with `store: false`: OpenAI keeps no
 * application state for them, so each turn sends the whole conversation and
 * reasoning is passed back encrypted (`reasoning.encrypted_content`). Abuse
 * monitoring logs are still kept up to 30 days under OpenAI's default terms
 * (B4, recorded 2026-10-19).
 */

// ── Prices ─────────────────────────────────────────────────────────────────

/**
 * US dollars per million tokens, standard tier, prompts under 272K tokens,
 * from https://developers.openai.com/api/docs/pricing on 2026-10-19. A model
 * not listed cannot be used: its cost could not be counted against the cap.
 */
export const PRICES: Record<string, { input: number; cached: number; output: number }> = {
  "gpt-6-astra": { input: 10, cached: 1, output: 50 },
  "gpt-6.1-sol": { input: 2, cached: 0.1, output: 10 },
  "gpt-6-sol": { input: 2, cached: 0.2, output: 10 },
  "gpt-6-luna": { input: 0.1, cached: 0.01, output: 0.5 },
  "gpt-5.6-sol": { input: 4, cached: 0.4, output: 20 },
  "gpt-5.6-terra": { input: 2, cached: 0.2, output: 12 },
  "gpt-5.6-luna": { input: 0.2, cached: 0.02, output: 1.2 },
};

export type Usage = { inputTokens: number; cachedTokens: number; outputTokens: number; reasoningTokens: number };

export const NO_USAGE: Usage = { inputTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0 };

export const addUsage = (a: Usage, b: Usage): Usage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  cachedTokens: a.cachedTokens + b.cachedTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  reasoningTokens: a.reasoningTokens + b.reasoningTokens,
});

/** Cost in millionths of a US dollar, rounded up so the cap is never undercounted. Reasoning is billed as output. */
export function costMicros(model: string, u: Usage): number {
  const p = PRICES[model];
  if (!p) throw new Error(`No price for model ${model}`);
  // $ per million tokens is exactly micro-dollars per token.
  return Math.ceil((u.inputTokens - u.cachedTokens) * p.input + u.cachedTokens * p.cached + u.outputTokens * p.output);
}

// ── Configuration ──────────────────────────────────────────────────────────

/** Proposed 2026-10-19 (pack B2), pending Zohair's confirmation; `ASK_MODEL` overrides it. */
export const DEFAULT_MODEL = "gpt-6.1-sol";
const EFFORTS = ["none", "low", "medium", "high"] as const;
type Effort = (typeof EFFORTS)[number];

export function askModel(): { model: string; effort: Effort } {
  const model = process.env.ASK_MODEL?.trim() || DEFAULT_MODEL;
  if (!PRICES[model]) throw new Error(`ASK_MODEL ${model} has no price in llm.server.ts`);
  const asked = process.env.ASK_REASONING?.trim() as Effort | undefined;
  return { model, effort: asked && EFFORTS.includes(asked) ? asked : "low" };
}

let client: OpenAI | null = null;
function openai(): OpenAI {
  if (!client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new LlmError("config", "OPENAI_API_KEY is not set");
    // Retries are ours (only rate limits and server errors, and only before anything streamed).
    client = new OpenAI({ apiKey, maxRetries: 0 });
  }
  return client;
}

// ── Items ──────────────────────────────────────────────────────────────────

/** Conversation items, opaque outside this module. */
export type Item = { readonly __item: unique symbol } & Record<string, unknown>;

const item = (x: Record<string, unknown>) => x as Item;
export const userItem = (text: string) => item({ role: "user", content: text });
export const assistantItem = (text: string) => item({ role: "assistant", content: text });
export const toolOutputItem = (callId: string, output: string) => item({ type: "function_call_output", call_id: callId, output });

// ── A turn ─────────────────────────────────────────────────────────────────

export type ToolSpec = { name: string; description: string; parameters: Record<string, unknown> };

export type ToolCall = { callId: string; name: string; arguments: string };

export type Turn = {
  text: string;
  /** The model declined (a safety refusal), in its words. */
  refusal: string | null;
  calls: ToolCall[];
  /** The turn's output, to send back with the next request (reasoning, calls, text). */
  items: Item[];
  usage: Usage;
  /** Cut short: the output limit, or a content filter. */
  incomplete: string | null;
};

export class LlmError extends Error {
  constructor(
    readonly kind: "config" | "rate_limit" | "server" | "timeout" | "request" | "failed",
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const RETRY_DELAYS_MS = [1_000, 3_000];
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new LlmError("timeout", "aborted"));
    });
  });

function classify(e: unknown, signal?: AbortSignal): LlmError {
  if (e instanceof LlmError) return e;
  if (signal?.aborted) return new LlmError("timeout", "The answer took too long");
  if (e instanceof APIError) {
    const status = e.status ?? 0;
    if (status === 429) return new LlmError("rate_limit", e.message, status);
    if (status >= 500) return new LlmError("server", e.message, status);
    return new LlmError("request", e.message, status);
  }
  return new LlmError("failed", e instanceof Error ? e.message : String(e));
}

/**
 * One model call, streamed: text deltas go to `onText` as they arrive, and
 * the turn's tool calls, output items and usage come back at the end. A rate
 * limit or server error is retried twice, and only while nothing has streamed
 * yet; anything else fails at once.
 */
export async function runTurn(opts: {
  model: string;
  effort: Effort;
  instructions: string;
  input: readonly Item[];
  tools: readonly ToolSpec[];
  /** False for the last round: answer with what the tools already returned. */
  allowTools: boolean;
  /** A stable hash of the user, for the provider's abuse monitoring (never an email). */
  safetyId: string;
  signal?: AbortSignal;
  onText?: (delta: string) => void;
}): Promise<Turn> {
  for (let attempt = 0; ; attempt++) {
    let streamed = false;
    try {
      const stream = await openai().responses.create(
        {
          model: opts.model,
          instructions: opts.instructions,
          input: opts.input as unknown as OpenAI.Responses.ResponseInput,
          tools: opts.tools.map((t) => ({ type: "function" as const, name: t.name, description: t.description, parameters: t.parameters, strict: true })),
          tool_choice: opts.allowTools ? "auto" : "none",
          parallel_tool_calls: true,
          reasoning: { effort: opts.effort },
          store: false,
          include: ["reasoning.encrypted_content"],
          prompt_cache_key: "growzar-ask",
          safety_identifier: opts.safetyId,
          max_output_tokens: 4_000,
          stream: true,
        },
        { signal: opts.signal },
      );
      let text = "";
      let refusal = "";
      for await (const ev of stream) {
        switch (ev.type) {
          case "response.output_text.delta":
            streamed = true;
            text += ev.delta;
            opts.onText?.(ev.delta);
            break;
          case "response.refusal.delta":
            streamed = true;
            refusal += ev.delta;
            break;
          case "response.failed":
            throw new LlmError("failed", ev.response.error?.message ?? "The model failed");
          case "error":
            throw new LlmError("failed", ev.message);
          case "response.completed":
          case "response.incomplete": {
            const r = ev.response;
            const output = r.output ?? [];
            const u = r.usage;
            return {
              text,
              refusal: refusal || null,
              calls: output.flatMap((o) => (o.type === "function_call" ? [{ callId: o.call_id, name: o.name, arguments: o.arguments }] : [])),
              // Sent back as they came, encrypted reasoning included.
              items: output.map((o) => item(o as unknown as Record<string, unknown>)),
              usage: {
                inputTokens: u?.input_tokens ?? 0,
                cachedTokens: u?.input_tokens_details?.cached_tokens ?? 0,
                outputTokens: u?.output_tokens ?? 0,
                reasoningTokens: u?.output_tokens_details?.reasoning_tokens ?? 0,
              },
              incomplete: ev.type === "response.incomplete" ? (r.incomplete_details?.reason ?? "incomplete") : null,
            };
          }
        }
      }
      throw new LlmError("failed", "The stream ended without a response");
    } catch (e) {
      const err = classify(e, opts.signal);
      const retryable = (err.kind === "rate_limit" || err.kind === "server") && !streamed && attempt < RETRY_DELAYS_MS.length;
      if (!retryable) throw err;
      await sleep(RETRY_DELAYS_MS[attempt]!, opts.signal);
    }
  }
}
