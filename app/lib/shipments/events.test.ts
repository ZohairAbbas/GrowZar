import { describe, expect, it } from "vitest";

import {
  courierCoverage,
  currentStatusTiming,
  eventKeyOf,
  parseEvent,
  replayStatus,
  timeline,
} from "./events";

/** A feed row as Courierify serves it. */
function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "101",
    shipmentId: "shp_1",
    status: "delivered",
    previousStatus: "out_for_delivery",
    source: "tracking_poll",
    courierEventAt: "2026-09-20T09:15:00.000Z",
    observedAt: "2026-09-20T12:00:00.000Z",
    raw: "Delivered",
    createdAt: "2026-09-20T12:00:01.000Z",
    ...overrides,
  };
}

function event(
  status: string,
  observedAt: string,
  courierEventAt: string | null,
  id: number,
  source = "tracking_poll",
) {
  const parsed = parseEvent(
    row({ id: String(id), status, observedAt, courierEventAt, source }),
  );
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.event;
}

describe("parseEvent", () => {
  it("keeps a null courierEventAt as null — never the observation time (rule #9)", () => {
    const parsed = parseEvent(row({ courierEventAt: null }));
    expect(parsed.ok && parsed.event.courierEventAt).toBeNull();
    expect(parsed.ok && parsed.event.observedAt.toISOString()).toBe(
      "2026-09-20T12:00:00.000Z",
    );
  });

  it("rejects a courier time it cannot read rather than calling it null", () => {
    expect(parseEvent(row({ courierEventAt: "yesterday-ish" }))).toEqual({
      ok: false,
      reason: "courierEventAt unparseable",
    });
  });

  it("keeps source verbatim, so backfilled and observed events stay distinguishable", () => {
    const parsed = parseEvent(row({ source: "backfill" }));
    expect(parsed.ok && parsed.event.source).toBe("backfill");
  });

  it("reads Courierify's id as a bigint, beyond Number's safe range", () => {
    const parsed = parseEvent(row({ id: "9007199254740993" }));
    expect(parsed.ok && parsed.event.sourceEventId).toBe(9007199254740993n);
  });

  it.each(["id", "shipmentId", "status", "source", "observedAt", "createdAt"])(
    "rejects a row without %s",
    (field) => {
      expect(parseEvent(row({ [field]: undefined })).ok).toBe(false);
    },
  );
});

describe("eventKeyOf", () => {
  it("gives a null-time event a stable key, so a repeat is a duplicate and not a new row", () => {
    const observed = new Date("2026-09-20T12:00:00Z");
    expect(eventKeyOf("booked", null, observed)).toBe(eventKeyOf("booked", null, observed));
    expect(eventKeyOf("booked", null, observed)).toContain("|-|");
  });

  it("separates a correction from the event it corrects", () => {
    const observed = new Date("2026-09-20T12:00:00Z");
    expect(eventKeyOf("delivered", null, observed)).not.toBe(
      eventKeyOf("delivered", new Date("2026-09-20T09:00:00Z"), observed),
    );
  });
});

describe("timeline and replay", () => {
  it("orders by observedAt, then Courierify's id", () => {
    const a = event("booked", "2026-09-01T00:00:00Z", null, 5);
    const b = event("picked_up", "2026-09-02T00:00:00Z", null, 3);
    const c = event("in_transit", "2026-09-02T00:00:00Z", null, 4);
    expect(timeline([c, a, b]).map((e) => e.status)).toEqual([
      "booked",
      "picked_up",
      "in_transit",
    ]);
  });

  it("replays to the latest status", () => {
    expect(
      replayStatus([
        event("returned", "2026-09-05T00:00:00Z", null, 3, "backfill"),
        event("booked", "2026-09-01T00:00:00Z", "2026-09-01T00:00:00Z", 1, "backfill"),
      ]),
    ).toBe("returned");
  });

  it("has no status for a parcel with no events", () => {
    expect(replayStatus([])).toBeNull();
  });
});

describe("currentStatusTiming (rule #9)", () => {
  it("says 'happened on' only when the courier gave a time", () => {
    const timing = currentStatusTiming([
      event("booked", "2026-09-01T00:00:00Z", "2026-09-01T00:00:00Z", 1),
      event("delivered", "2026-09-03T12:00:00Z", "2026-09-03T09:00:00Z", 2),
    ]);
    expect(timing).toMatchObject({ basis: "happened_on", status: "delivered" });
    expect(timing?.at.toISOString()).toBe("2026-09-03T09:00:00.000Z");
  });

  it("says 'status as of' for a backfilled state-as-of event, never 'delivered on'", () => {
    const timing = currentStatusTiming([
      event("booked", "2026-09-01T00:00:00Z", "2026-09-01T00:00:00Z", 1, "backfill"),
      event("delivered", "2026-09-28T05:00:00Z", null, 2, "backfill"),
    ]);
    expect(timing).toMatchObject({ basis: "status_as_of", status: "delivered" });
    expect(timing?.at.toISOString()).toBe("2026-09-28T05:00:00.000Z");
  });

  it("uses a later correction's courier time for the same status", () => {
    const timing = currentStatusTiming([
      event("delivered", "2026-09-03T12:00:00Z", null, 2),
      event("delivered", "2026-09-03T18:00:00Z", "2026-09-03T09:00:00Z", 3, "tracking_poll_correction"),
    ]);
    expect(timing).toMatchObject({ basis: "happened_on", source: "tracking_poll_correction" });
  });

  it("does not borrow a courier time from an earlier, different status", () => {
    const timing = currentStatusTiming([
      event("in_transit", "2026-09-02T00:00:00Z", "2026-09-02T00:00:00Z", 1),
      event("returned", "2026-09-09T00:00:00Z", null, 2),
    ]);
    expect(timing?.basis).toBe("status_as_of");
  });
});

describe("courierCoverage", () => {
  const timed = () => [event("delivered", "2026-09-03T12:00:00Z", "2026-09-03T09:00:00Z", 1)];
  const asOf = () => [event("delivered", "2026-09-28T05:00:00Z", null, 1, "backfill")];

  it("returns not_enough_data for a courier with no courier history, not a number", () => {
    const parcels = Array.from({ length: 500 }, () => ({ courier: "tranzo", events: asOf() }));
    expect(courierCoverage(parcels)).toEqual([
      {
        courier: "tranzo",
        parcels: 500,
        parcelsWithEvents: 500,
        parcelsWithCourierTime: 0,
        verdict: "not_enough_data",
        reason: "no_courier_history",
      },
    ]);
  });

  it("returns not_enough_data below the sample floor", () => {
    const parcels = Array.from({ length: 5 }, () => ({ courier: "trax", events: timed() }));
    expect(courierCoverage(parcels)[0]).toMatchObject({ reason: "too_few_parcels" });
  });

  it("is ok with enough timed parcels", () => {
    const parcels = Array.from({ length: 40 }, () => ({ courier: "PostEx", events: timed() }));
    expect(courierCoverage(parcels)[0]).toMatchObject({ courier: "postex", verdict: "ok" });
  });
});
