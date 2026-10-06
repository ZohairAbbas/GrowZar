/**
 * Courierify's shipment status event log, as Growzar stores and reads it
 * (G-GZR2-1).
 *
 * Pure: no database, no clock. The sync writes what `parseEvent` accepts, and
 * everything that reads the log — replay, "delivered on" versus "status as
 * of", per-courier coverage — goes through the functions here, so the rules
 * are stated once.
 *
 * What the log is, in Courierify's words (its route documents the limits):
 * a *sampled* history, polled every 360 minutes, with status writes outside
 * the poll recorded by a trigger. History before 2026-09 is reconstructed
 * (`source: "backfill"`), and a parcel with no timed history carries a single
 * backfilled "state as of" event with no courier time.
 */

/** One event as Growzar keeps it. */
export type ShipmentEventRecord = {
  shipmentId: string;
  status: string;
  previousStatus: string | null;
  source: string;
  /** Null when the courier gave no time. Never filled in (rule #9). */
  courierEventAt: Date | null;
  observedAt: Date;
  raw: string | null;
  sourceEventId: bigint;
  sourceCreatedAt: Date;
  eventKey: string;
};

export type ParseResult =
  | { ok: true; event: ShipmentEventRecord }
  | { ok: false; reason: string };

function date(value: unknown): Date | null {
  if (typeof value !== "string" || !value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * The dedupe key, minus the store and parcel (which are columns of the same
 * unique index): `status|courierEventAt|observedAt`.
 *
 * `-` stands for a null courier time here and nowhere else. It exists because
 * Postgres treats NULLs as distinct in a unique index, so keying on the
 * nullable column directly would let every null-time event be written again
 * on every overlapping run.
 */
export function eventKeyOf(
  status: string,
  courierEventAt: Date | null,
  observedAt: Date,
): string {
  // Epoch milliseconds rather than ISO strings: the key sits in the heap and
  // in the unique index, and 23 fewer characters twice is ~10% of the table.
  return [
    status,
    courierEventAt ? String(courierEventAt.getTime()) : "-",
    String(observedAt.getTime()),
  ].join("|");
}

/**
 * Accept one row of `/api/v1/growzar/shipment-events`, or say why not.
 *
 * `courierEventAt` is the field that must survive exactly as sent. A present
 * but unparseable value is a rejection rather than a null: turning a courier
 * time we could not read into "the courier gave no time" would be inventing
 * information in the other direction.
 */
export function parseEvent(row: unknown): ParseResult {
  if (!row || typeof row !== "object") return { ok: false, reason: "not an object" };
  const r = row as Record<string, unknown>;

  const id = typeof r.id === "string" && /^\d+$/.test(r.id)
    ? BigInt(r.id)
    : typeof r.id === "number" && Number.isSafeInteger(r.id)
      ? BigInt(r.id)
      : null;
  const shipmentId = text(r.shipmentId);
  const status = text(r.status);
  const source = text(r.source);
  const observedAt = date(r.observedAt);
  const createdAt = date(r.createdAt);

  if (id === null) return { ok: false, reason: "id" };
  if (!shipmentId) return { ok: false, reason: "shipmentId" };
  if (!status) return { ok: false, reason: "status" };
  if (!source) return { ok: false, reason: "source" };
  if (!observedAt) return { ok: false, reason: "observedAt" };
  if (!createdAt) return { ok: false, reason: "createdAt" };

  let courierEventAt: Date | null = null;
  if (r.courierEventAt !== null && r.courierEventAt !== undefined) {
    courierEventAt = date(r.courierEventAt);
    if (!courierEventAt) return { ok: false, reason: "courierEventAt unparseable" };
  }

  return {
    ok: true,
    event: {
      shipmentId,
      status,
      previousStatus: text(r.previousStatus),
      source,
      courierEventAt,
      observedAt,
      raw: typeof r.raw === "string" ? r.raw : null,
      sourceEventId: id,
      sourceCreatedAt: createdAt,
      eventKey: eventKeyOf(status, courierEventAt, observedAt),
    },
  };
}

type TimelineEvent = Pick<
  ShipmentEventRecord,
  "status" | "courierEventAt" | "observedAt" | "sourceEventId" | "source"
>;

/**
 * A parcel's events in timeline order: `(observedAt, id)`, which is the order
 * Courierify documents for rebuilding a timeline. Backfilled history carries
 * the observation time of the history it came from, so it sorts before the
 * first live event. Not `courierEventAt`: it is null on a sixth of events,
 * and a correction carries an earlier courier time than the event it corrects.
 */
export function timeline<T extends TimelineEvent>(events: readonly T[]): T[] {
  return [...events].sort((a, b) => {
    const byObserved = a.observedAt.getTime() - b.observedAt.getTime();
    if (byObserved !== 0) return byObserved;
    return a.sourceEventId < b.sourceEventId ? -1 : a.sourceEventId > b.sourceEventId ? 1 : 0;
  });
}

/** The parcel's current status according to its events, or null if it has none. */
export function replayStatus(events: readonly TimelineEvent[]): string | null {
  return timeline(events).at(-1)?.status ?? null;
}

/**
 * When the parcel's current status happened, and how sure we are (rule #9).
 *
 * `happened_on`: the courier gave a time for entering this status. The screen
 * may say "delivered on <at>".
 *
 * `reported_by_3pl`: no courier time, but the 3PL that booked the parcel
 * posted a dated event (Courierify G-CFY3-1, `source =
 * "shopify_fulfillment_event"`). Those are the 3PL's observations, about five
 * minutes behind the courier, not times the courier asserted, so the screen
 * says "reported by <3PL> on <at>" and they never count as courier times.
 *
 * `status_as_of`: no event of the current stretch has a time. The
 * screen says "status as of <at>" and never "delivered on". `at` is the most
 * recent observation, because that is the latest moment we know it held.
 *
 * "The current stretch" is the trailing run of events with the current
 * status, so a `tracking_poll_correction` that learned the courier time after
 * the poll that first saw the status still counts. The earliest courier time
 * in that run is the moment the status was entered.
 */
export type StatusTiming =
  | { status: string; basis: "happened_on"; at: Date; source: string }
  | { status: string; basis: "reported_by_3pl"; at: Date; source: string }
  | { status: string; basis: "status_as_of"; at: Date; source: string };

/** Events a 3PL posted: its observations, never courier times (rule #9). */
export const THIRD_PARTY_SOURCE = "shopify_fulfillment_event";
/** A time the courier itself gave. */
export const isCourierTimed = (e: { source: string; courierEventAt: Date | null }) =>
  !!e.courierEventAt && e.source !== THIRD_PARTY_SOURCE;

export function currentStatusTiming(
  events: readonly TimelineEvent[],
): StatusTiming | null {
  const ordered = timeline(events);
  const latest = ordered.at(-1);
  if (!latest) return null;

  const status = latest.status;
  let start = ordered.length - 1;
  while (start > 0 && ordered[start - 1]!.status === status) start -= 1;
  const run = ordered.slice(start);

  // A courier's own time wins; a 3PL's comes next; then "as of".
  const earliest = (keep: (e: TimelineEvent) => boolean) => {
    let found: TimelineEvent | null = null;
    for (const event of run) {
      if (!event.courierEventAt || !keep(event)) continue;
      if (!found || event.courierEventAt < found.courierEventAt!) found = event;
    }
    return found;
  };
  const courier = earliest(isCourierTimed);
  if (courier) return { status, basis: "happened_on", at: courier.courierEventAt!, source: courier.source };
  const thirdParty = earliest((e) => e.source === THIRD_PARTY_SOURCE);
  if (thirdParty) return { status, basis: "reported_by_3pl", at: thirdParty.courierEventAt!, source: thirdParty.source };

  return { status, basis: "status_as_of", at: latest.observedAt, source: latest.source };
}

/**
 * Below this many parcels with at least one courier-timed event, a courier's
 * timing metrics are "not enough data". Chosen so a courier that appears on a
 * handful of parcels cannot produce a confident per-courier number; it is a
 * floor against noise, not a measured threshold, and Phase 3 may raise it.
 */
export const MIN_TIMED_PARCELS_PER_COURIER = 30;

/**
 * The one place that decides whether a courier has enough courier-timed
 * history for a per-courier timing metric. Parcel-level coverage (above) and
 * the order-level roll-up both call it, so the threshold cannot drift.
 */
export function coverageVerdict(
  timed: number,
  minimum = MIN_TIMED_PARCELS_PER_COURIER,
):
  | { verdict: "ok" }
  | { verdict: "not_enough_data"; reason: "no_courier_history" | "too_few_parcels" } {
  if (timed === 0) return { verdict: "not_enough_data", reason: "no_courier_history" };
  if (timed < minimum) return { verdict: "not_enough_data", reason: "too_few_parcels" };
  return { verdict: "ok" };
}

export type CourierCoverage =
  | {
      courier: string;
      parcels: number;
      parcelsWithEvents: number;
      parcelsWithCourierTime: number;
      verdict: "ok";
    }
  | {
      courier: string;
      parcels: number;
      parcelsWithEvents: number;
      parcelsWithCourierTime: number;
      verdict: "not_enough_data";
      reason: "no_courier_history" | "too_few_parcels";
    };

/**
 * Whether a courier's event history can support a per-courier metric.
 *
 * Four couriers (tranzo, dotexpress, zaaf, bouraq — ~3.3% of parcels) have no
 * courier history at all: every parcel carries one backfilled "as of" event.
 * A courier with no timed events would otherwise look like one that never
 * delivers — the exact shape of a confidently wrong insight — so any
 * per-courier metric must consult this first and return "not enough data"
 * instead of a number.
 */
export function courierCoverage(
  parcels: ReadonlyArray<{ courier: string | null; events: readonly TimelineEvent[] }>,
  minimum = MIN_TIMED_PARCELS_PER_COURIER,
): CourierCoverage[] {
  const byCourier = new Map<string, { parcels: number; withEvents: number; timed: number }>();

  for (const parcel of parcels) {
    const courier = parcel.courier?.trim().toLowerCase() || "unknown";
    const entry = byCourier.get(courier) ?? { parcels: 0, withEvents: 0, timed: 0 };
    entry.parcels += 1;
    if (parcel.events.length) entry.withEvents += 1;
    if (parcel.events.some(isCourierTimed)) entry.timed += 1;
    byCourier.set(courier, entry);
  }

  return [...byCourier.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([courier, c]) => {
      const base = {
        courier,
        parcels: c.parcels,
        parcelsWithEvents: c.withEvents,
        parcelsWithCourierTime: c.timed,
      };
      const verdict = coverageVerdict(c.timed, minimum);
      return { ...base, ...verdict } as CourierCoverage;
    });
}
