import { describe, expect, it } from "vitest";

import { conversationsView, isWaiting, parseConversation, type Conversation } from "./conversations";

const NOW = new Date("2026-10-11T12:00:00Z");
const at = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

function conv(id: string, o: Partial<Conversation> = {}): Conversation {
  return {
    id, channel: "whatsapp", phone: "+923000001234", status: "resolved", owner: "ai", category: "retention", subcategory: "tracking",
    createdAt: at(48), lastInboundAt: at(47), lastOutboundAt: at(46), firstResponseAt: new Date(at(48).getTime() + 2 * 60_000), slaDueAt: null,
    escalated: false, inbound: 2, outboundAi: 2, outboundAgent: 0, aiCost: { amount: "0.0100", currency: "USD" }, csat: null, orders: 0, ...o,
  };
}

describe("parseConversation", () => {
  it("reads WhatKaBot's metadata row, never a name or text", () => {
    const c = parseConversation({
      id: "c1", channel: "whatsapp", customer: { phone: "+923000001234", phoneRaw: "03000001234", email: null }, status: "open",
      assignee: { type: "agent", agentId: "a1" }, category: "complaint", subcategory: "payment_issue", createdAt: "2026-10-10T10:00:00.000Z",
      messages: { inbound: 3, outboundAi: 1, outboundAgent: 2, outboundAutomated: 0 }, aiCost: { amount: "0.0042", currency: "USD" },
      orders: ["5550001"], escalated: true, updatedAt: "2026-10-10T11:00:00.000Z",
    });
    expect(c).toMatchObject({ owner: "agent", inbound: 3, outboundAgent: 2, orders: 1, escalated: true, aiCost: { amount: "0.0042", currency: "USD" } });
  });
});

describe("conversationsView", () => {
  it("splits the period's conversations by who answered, with the median first response", () => {
    const v = conversationsView({
      inPeriod: [conv("a"), conv("b", { outboundAgent: 1, firstResponseAt: new Date(at(48).getTime() + 10 * 60_000) }), conv("c", { outboundAi: 0, firstResponseAt: null, escalated: true })],
      open: [],
      messages: [],
      now: NOW,
    });
    expect(v).toMatchObject({ opened: 3, aiOnly: 1, withAgent: 1, unanswered: 1, escalated: 1, medianFirstResponseMinutes: 6 });
    expect(v.aiCost).toEqual([{ amount: "0.03", currency: "USD" }]);
  });

  it("lists conversations waiting on the store, longest first, with overdue flagged", () => {
    const waiting = conv("w", { status: "pending_agent", lastInboundAt: at(5), lastOutboundAt: at(6), slaDueAt: at(1), phone: "+923000005678" });
    const answered = conv("x", { status: "open", lastInboundAt: at(3), lastOutboundAt: at(2) });
    const v = conversationsView({ inPeriod: [], open: [waiting, answered], messages: [], now: NOW });
    expect(isWaiting(answered)).toBe(false);
    expect(v.now).toEqual({ open: 2, waiting: 1, quiet: 0, pendingAgent: 1, overdue: 1 });
    expect(v.waitingList).toEqual([expect.objectContaining({ id: "w", phoneTail: "5678", waitingMinutes: 300, overdue: true })]);
  });

  it("counts a buyer who wrote over 7 days ago as gone quiet, not waiting", () => {
    const old = conv("o", { status: "open", lastInboundAt: at(24 * 8), lastOutboundAt: at(24 * 9) });
    const v = conversationsView({ inPeriod: [], open: [old], messages: [], now: NOW });
    expect([v.now.waiting, v.now.quiet, v.waitingList.length]).toEqual([0, 1, 0]);
  });

  it("groups by category with each one's share and top subcategory", () => {
    const v = conversationsView({
      inPeriod: [conv("a"), conv("b"), conv("c", { category: "complaint", subcategory: "damaged", orders: 1 })],
      open: [], messages: [], now: NOW,
    });
    expect(v.categories.map((k) => [k.category, k.conversations, k.share, k.topSubcategory, k.withOrder])).toEqual([
      ["retention", 2, 66.7, "tracking", 0],
      ["complaint", 1, 33.3, "damaged", 1],
    ]);
  });

  it("counts messages by author and failures by code", () => {
    const m = (direction: "inbound" | "outbound", author: string, deliveryStatus: string | null = "delivered", errorCode: string | null = null) => ({ direction, author, createdAt: at(1), deliveryStatus, errorCode });
    const v = conversationsView({ inPeriod: [], open: [], now: NOW, messages: [m("inbound", "customer"), m("outbound", "ai"), m("outbound", "ai"), m("outbound", "campaign", "failed", "meta_131049"), m("outbound", "agent", "failed", null)] });
    expect(v.messages).toEqual({
      inbound: 1,
      outboundByAuthor: [{ author: "ai", messages: 2 }, { author: "campaign", messages: 1 }, { author: "agent", messages: 1 }],
      failed: 2,
      failedByCode: [{ code: "meta_131049", messages: 1 }, { code: "unreported", messages: 1 }],
    });
  });
});
