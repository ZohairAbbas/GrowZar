import { describe, expect, it } from "vitest";

import { attribute, buyerPhone, messagingView, parseMessage, type FollowedOrder, type MessageRow } from "./messaging";

const at = (s: string) => new Date(`2026-10-${s}Z`);
const pkr = (amount: string) => ({ amount, currency: "PKR" });

function msg(id: string, o: Partial<MessageRow> = {}): MessageRow {
  return { id, channel: "email", journeyId: "j1", sentAt: at("01T10:00:00"), deliveredAt: at("01T10:00:05"), openedAt: null, readAt: null, clickedAt: null, failedAt: null, customerId: "c1", ...o };
}
function order(id: string, placed: string, o: Partial<FollowedOrder> = {}): FollowedOrder {
  return { orderId: id, customerId: "c1", placedAt: at(placed), outcome: "delivered", delivered: pkr("1000.00"), ...o };
}

describe("buyerPhone: Retainify's digits to the E.164 Growzar keys customers by", () => {
  it("keeps E.164, reads local digits with the store's country, and international digits without a +", () => {
    expect(buyerPhone("+923001234567", null, null)).toBe("+923001234567");
    expect(buyerPhone(null, "03001234567", "PK")).toBe("+923001234567");
    expect(buyerPhone(null, "923001234567", "PK")).toBe("+923001234567");
    expect(buyerPhone(null, "923001234567", null)).toBe("+923001234567");
  });

  it("guesses nothing when the store's country is unknown and the digits are local", () => {
    expect(buyerPhone(null, "03001234567", null)).toBeNull();
    expect(buyerPhone(null, null, "PK")).toBeNull();
  });
});

describe("attribution: 7 days after a click, else 1 day after the message reached the buyer", () => {
  it("credits an order placed within a day of delivery", () => {
    expect(attribute(order("o", "02T09:00:00"), [msg("m")])).toMatchObject({ via: "reach" });
    expect(attribute(order("o", "02T11:00:00"), [msg("m")])).toBeNull();
  });

  it("credits a click for 7 days, and prefers it over a later delivery", () => {
    const clicked = msg("clicked", { clickedAt: at("01T12:00:00") });
    const later = msg("later", { sentAt: at("05T10:00:00"), deliveredAt: at("05T10:00:05") });
    expect(attribute(order("o", "05T12:00:00"), [clicked, later])).toMatchObject({ via: "click", message: { id: "clicked" } });
    expect(attribute(order("o", "09T13:00:00"), [clicked])).toBeNull();
  });

  it("never credits a message to an order placed before it, or to another buyer", () => {
    expect(attribute(order("o", "01T09:00:00"), [msg("m")])).toBeNull();
    expect(attribute(order("o", "01T12:00:00", { customerId: "c2" }), [msg("m")])).toBeNull();
  });

  it("treats a failed message as never reaching anyone, and one with no delivery report as reached when sent", () => {
    expect(attribute(order("o", "01T12:00:00"), [msg("m", { deliveredAt: null, failedAt: at("01T10:00:09") })])).toBeNull();
    expect(attribute(order("o", "01T12:00:00"), [msg("p", { channel: "push", deliveredAt: null })])).toMatchObject({ via: "reach" });
    expect(attribute(order("o", "01T12:00:00"), [msg("e", { deliveredAt: null })])).toMatchObject({ via: "reach" });
  });
});

describe("messagingView", () => {
  it("counts each followed order once, by its outcome, with delivered revenue only", () => {
    const v = messagingView({
      messages: [msg("a"), msg("b", { journeyId: "j2", sentAt: at("01T11:00:00"), deliveredAt: at("01T11:00:05") })],
      journeys: [{ id: "j1", name: "Cart reminder", kind: "flow" }, { id: "j2", name: "Weekend sale", kind: "campaign" }],
      orders: [order("o1", "01T12:00:00"), order("o2", "01T13:00:00", { outcome: "returned", delivered: null })],
    });
    expect(v.followed).toMatchObject({ orders: 2, delivered: 1, returned: 1, deliveredRevenue: [pkr("1000.00")], viaReach: 2 });
    // Both follow j2's later message, the latest one that qualifies.
    expect(v.journeys.map((j) => [j.name, j.kind, j.sent, j.orders])).toEqual([["Weekend sale", "campaign", 1, 2], ["Cart reminder", "flow", 1, 0]]);
    expect(v.channels).toEqual([{ channel: "email", sent: 2, reached: 2, opened: 0, clicked: 0, failed: 0, noDeliveryReport: 0 }]);
  });

  it("counts messages with no delivery report, which are timed from when they were sent", () => {
    expect(messagingView({ messages: [msg("a", { deliveredAt: null }), msg("b")], journeys: [], orders: [] }).channels[0]).toMatchObject({ reached: 2, noDeliveryReport: 1 });
  });

  it("does not credit a message with the second order of the same shopping session", () => {
    const v = messagingView({
      messages: [msg("pp", { sentAt: at("01T10:00:00"), deliveredAt: at("01T10:00:01") })],
      journeys: [],
      orders: [order("first", "01T09:59:00"), order("second", "01T10:20:00"), order("later", "01T20:00:00")],
    });
    expect(v.followed).toMatchObject({ orders: 1, sameSession: 1 });
  });

  it("reports how many messages matched a customer", () => {
    expect(messagingView({ messages: [msg("a"), msg("b", { customerId: null })], journeys: [], orders: [] })).toMatchObject({ messages: 2, matched: 1 });
  });
});

describe("parseMessage", () => {
  it("reads Retainify's row, with the buyer's phone kept apart for resolving", () => {
    expect(
      parseMessage({ id: "whatsapp:x", channel: "whatsapp", journeyId: "j", sentAt: "2026-10-01T10:00:02.000Z", readAt: "2026-10-01T10:03:00.000Z", buyer: { email: "b@example.test", phone: null, phoneRaw: "03001234567" } }),
    ).toMatchObject({ channel: "whatsapp", readAt: new Date("2026-10-01T10:03:00.000Z"), phoneE164: null, phoneRaw: "03001234567" });
    expect(parseMessage({ id: "x", channel: "sms" })).toBeNull();
  });
});
