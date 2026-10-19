import { z } from "zod";

import type { Route } from "./+types/api.ask";
import { askContext } from "~/lib/ask/context.server";
import { ask, askEnabled, type AskEvent } from "~/lib/ask/loop.server";

/**
 * `POST /api/ask` — one question, answered as a stream of newline-delimited
 * JSON events (`AskEvent`): the conversation, text as it is written, each
 * tool's table as it returns, then `done` with the status and usage.
 *
 * The viewer, their stores and their sections come from the session
 * (`askContext`), never from the body. JSON only, from Growzar's own origin:
 * a form on another site can neither send JSON nor spend this organization's
 * budget.
 */

const body = z
  .object({
    question: z.string().trim().min(1).max(2_000),
    conversationId: z.string().max(64).nullable().optional(),
    storeId: z.string().max(64).nullable().optional(),
  })
  .strict();

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("Origin");
  if (!origin) return false;
  const own = new URL(process.env.BETTER_AUTH_URL ?? request.url).origin;
  return origin === own || origin === new URL(request.url).origin;
}

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  if (!askEnabled()) return Response.json({ error: "Asking about your data is turned off." }, { status: 503 });
  if (!request.headers.get("Content-Type")?.startsWith("application/json") || !sameOrigin(request)) {
    return Response.json({ error: "Bad request." }, { status: 400 });
  }
  const ctx = await askContext(request);
  if (!ctx.can("home")) return Response.json({ error: "Your role does not include Home." }, { status: 403 });
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Ask a question of up to 2,000 characters." }, { status: 400 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: AskEvent) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(e)}\n`));
        } catch {
          // The reader has gone; the answer is still recorded.
        }
      };
      try {
        await ask({
          ctx,
          question: parsed.data.question,
          conversationId: parsed.data.conversationId ?? null,
          activeStoreId: parsed.data.storeId ?? null,
          onEvent: send,
          signal: request.signal,
        });
      } catch (e) {
        console.error("[ask] request failed", e);
        send({ type: "done", messageId: null, status: "error", text: "Something went wrong while answering. Try again in a moment.", usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0 }, costMicros: 0, latencyMs: 0 });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" },
  });
}

export function loader() {
  return new Response(null, { status: 405 });
}
