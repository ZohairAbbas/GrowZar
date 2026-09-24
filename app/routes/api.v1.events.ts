import type { Route } from "./+types/api.v1.events";
import { prisma } from "~/lib/db.server";
import { entityKeyOf, parseEnvelope } from "~/lib/events/envelope";
import { identifySender } from "~/lib/events/verify.server";
import { enqueueEvent } from "~/lib/events/queue.server";
import type { Prisma } from "@prisma/client";

/**
 * `POST /api/v1/events` — the relay's front door (API-CONTRACT §7, X1).
 *
 * The job here is to be fast and to be strict, in that order of visibility and
 * the opposite order of importance. Reply 202 the moment the event is safely
 * on disk; do the work somewhere else.
 *
 * Nothing unsigned is accepted, including from localhost. Every suite app runs
 * on this same box, so "it came from 127.0.0.1" is true of an attacker who has
 * got a foothold in any of the six — which is exactly the situation where the
 * signature is the only thing left standing.
 */
function json(body: unknown, status: number) {
  return Response.json(body, { status });
}

/** §9 error shape, so apps can act on `errorType` rather than parse prose. */
function fail(status: number, errorType: string, message: string) {
  return json({ error: message, errorType }, status);
}

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return fail(405, "bad_request", "Events are posted.");
  }

  const url = new URL(request.url);
  const pathWithQuery = `${url.pathname}${url.search}`;

  // The raw body, byte for byte. Re-serialising parsed JSON would change
  // whitespace and key order and break every signature.
  const raw = await request.text();

  const sender = identifySender({
    signature: request.headers.get("X-Growzar-Signature"),
    timestamp: request.headers.get("X-Growzar-Timestamp"),
    method: "POST",
    pathWithQuery,
    body: raw,
  });

  if (!sender.ok) {
    console.warn(`[events] rejected: ${sender.reason}`);
    return fail(401, "unauthorized", "This event was not signed by a known app.");
  }

  const parsed = parseEnvelope(raw);
  if (!parsed.ok) {
    return fail(400, "bad_request", `The envelope is not usable: ${parsed.problem}.`);
  }

  const { envelope } = parsed;
  const { app } = sender.sender;

  const store = await prisma.store.findUnique({
    where: { shopDomain: envelope.shopDomain },
    select: { id: true },
  });

  try {
    const stored = await prisma.inboundEvent.create({
      data: {
        eventId: envelope.eventId,
        app,
        topic: envelope.topic,
        shopDomain: envelope.shopDomain,
        storeId: store?.id ?? null,
        occurredAt: envelope.occurredAt,
        entityKey: entityKeyOf(envelope),
        actor: (envelope.actor ?? null) as Prisma.InputJsonValue,
        payload: envelope.data as Prisma.InputJsonValue,
      },
      select: { id: true },
    });

    // Enqueued after the row exists. If the queue is unreachable the event is
    // still on disk and the sweeper picks it up, so delivery is never lost to
    // Redis having a bad moment.
    await enqueueEvent(stored.id).catch((error) => {
      console.error("[events] could not enqueue; sweeper will collect it", error);
    });

    return json({ accepted: true, eventId: envelope.eventId }, 202);
  } catch (error) {
    const duplicate =
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "P2002";

    if (duplicate) {
      // §7: delivery is at-least-once, so a replay is expected and normal, not
      // an error. The unique index on eventId is what makes it safe, and 202
      // stops the app retrying something already handled.
      return json(
        { accepted: true, eventId: envelope.eventId, duplicate: true },
        202,
      );
    }

    console.error("[events] could not store event", error);
    return fail(500, "internal_error", "Could not accept that event.");
  }
}

/** A GET here is someone poking at the URL; it is not an endpoint. */
export function loader() {
  return fail(405, "bad_request", "Events are posted.");
}
