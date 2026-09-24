/**
 * The event envelope (API-CONTRACT §7).
 *
 * ```json
 * { "eventId": "01JB8Z…", "topic": "shipment.delivered",
 *   "occurredAt": "2026-09-23T06:04:11Z", "shop": "acme.myshopify.com",
 *   "actor": { "type": "courier", "id": "postex" }, "data": { … } }
 * ```
 */
export type EventEnvelope = {
  eventId: string;
  topic: string;
  occurredAt: Date;
  shopDomain: string;
  actor: unknown;
  data: Record<string, unknown>;
};

export type EnvelopeProblem =
  | "not_json"
  | "missing_eventId"
  | "missing_topic"
  | "missing_shop"
  | "bad_occurredAt";

/** The topics an app may send in v1 (§7). */
export const V1_TOPICS = [
  "order.created",
  "order.updated",
  "order.cancelled",
  "shipment.booked",
  "shipment.status_changed",
  "shipment.delivered",
  "shipment.returned",
  "return.received",
  "settlement.received",
  "payout.received",
  "cost.updated",
  "conversation.message_received",
  "conversation.assigned",
  "conversation.resolved",
  "form.abandoned",
  "app.installed",
  "app.uninstalled",
] as const;

export type V1Topic = (typeof V1_TOPICS)[number];

export function parseEnvelope(
  raw: string,
): { ok: true; envelope: EventEnvelope } | { ok: false; problem: EnvelopeProblem } {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { ok: false, problem: "not_json" };
  }

  const eventId = typeof body.eventId === "string" ? body.eventId.trim() : "";
  if (!eventId) return { ok: false, problem: "missing_eventId" };

  const topic = typeof body.topic === "string" ? body.topic.trim() : "";
  if (!topic) return { ok: false, problem: "missing_topic" };

  // §3: the shop is the *.myshopify.com domain, lowercase. An app that sends
  // its own internal UUID here has not identified a shop — Growzar never maps
  // UUIDs, and guessing would attach one app's event to another's store.
  const shopDomain =
    typeof body.shop === "string" ? body.shop.trim().toLowerCase() : "";
  if (!shopDomain.endsWith(".myshopify.com")) {
    return { ok: false, problem: "missing_shop" };
  }

  const occurredAtRaw = body.occurredAt;
  if (typeof occurredAtRaw !== "string") {
    return { ok: false, problem: "bad_occurredAt" };
  }
  const occurredAt = new Date(occurredAtRaw);
  if (Number.isNaN(occurredAt.getTime())) {
    return { ok: false, problem: "bad_occurredAt" };
  }

  return {
    ok: true,
    envelope: {
      eventId,
      topic,
      occurredAt,
      shopDomain,
      actor: body.actor ?? null,
      data:
        body.data && typeof body.data === "object"
          ? (body.data as Record<string, unknown>)
          : {},
    },
  };
}

/**
 * What this event is about, so a late arrival can be recognised as overtaken.
 *
 * §7 guarantees no ordering, so `shipment.delivered` can land after the
 * `shipment.returned` that followed it. Both carry the same entity key, and
 * the one with the older `occurredAt` loses.
 *
 * Only the canonical keys from §3 are used. An event whose subject cannot be
 * named returns null and is applied without an ordering check, because a
 * wrong key would silently suppress real events.
 */
export function entityKeyOf(envelope: EventEnvelope): string | null {
  const { topic, data } = envelope;
  const str = (value: unknown): string | null => {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    return null;
  };

  if (topic.startsWith("order.")) {
    const id = str(data.orderId) ?? str(data.shopifyOrderId) ?? str(data.id);
    return id ? `order:${id}` : null;
  }

  if (topic.startsWith("shipment.") || topic === "return.received") {
    const id = str(data.shipmentId) ?? str(data.parcelId) ?? str(data.id);
    return id ? `shipment:${id}` : null;
  }

  if (topic === "settlement.received" || topic === "payout.received") {
    const id = str(data.settlementId) ?? str(data.payoutId) ?? str(data.id);
    return id ? `settlement:${id}` : null;
  }

  if (topic === "cost.updated") {
    const id = str(data.variantId) ?? str(data.costId) ?? str(data.id);
    return id ? `cost:${id}` : null;
  }

  if (topic.startsWith("conversation.")) {
    const id = str(data.conversationId) ?? str(data.id);
    return id ? `conversation:${id}` : null;
  }

  // app.installed / app.uninstalled are about the connection itself, which is
  // one per app per store, so the app is the entity.
  if (topic.startsWith("app.")) return "app";

  return null;
}
