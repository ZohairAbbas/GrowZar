import { z } from "zod";

import type { Route } from "./+types/api.ask.feedback";
import { prisma } from "~/lib/db.server";
import { getViewer } from "~/lib/authorize.server";

/**
 * `POST /api/ask/feedback`: thumbs up or down on one of the member's own
 * answers, with an optional note. Feedback outlives the answer's text (B6).
 */
const body = z
  .object({
    messageId: z.string().max(64),
    feedback: z.enum(["up", "down"]),
    note: z.string().max(500).nullable().optional(),
  })
  .strict();

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST" || !request.headers.get("Content-Type")?.startsWith("application/json")) return new Response(null, { status: 400 });
  const viewer = await getViewer(request);
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return new Response(null, { status: 400 });
  const r = await prisma.askMessage.updateMany({
    where: { id: parsed.data.messageId, role: "assistant", conversation: { organizationId: viewer.organizationId, userId: viewer.userId } },
    data: { feedback: parsed.data.feedback, ...(parsed.data.note !== undefined ? { feedbackNote: parsed.data.note?.trim() || null } : {}) },
  });
  return new Response(null, { status: r.count ? 204 : 404 });
}

export function loader() {
  return new Response(null, { status: 405 });
}
