import { describe, expect, it } from "vitest";

import { consentView, parseConsent, parseConsentEvent, parseWhatKaBotConsent, parseWhatKaBotConsentEvent, reachableByCustomer, type ConsentContact } from "./consent";

const contact = (id: string, customerId: string | null, reachable: Partial<ConsentContact["reachable"]> = {}) => ({
  contactId: id, phoneE164: null, phoneRaw: null, customerId, reachable: { email: false, whatsapp: false, push: false, ...reachable },
});
const ev = (channel: "email" | "whatsapp" | "push", from: string | null, to: string, reason: string | null = null) => ({ channel, from, to, reason, createdAt: new Date("2026-10-01T00:00:00Z") });

describe("parsing Retainify's consent", () => {
  it("may message only where subscribed and not suppressed", () => {
    const c = parseConsent({
      contactId: "c1",
      buyer: { email: "b@example.test", phone: "+923001234567", phoneRaw: "923001234567" },
      email: { state: "subscribed", suppressed: false },
      whatsapp: { state: "subscribed", suppressed: true, suppressionReason: "opt_out" },
      push: { state: "unsubscribed" },
    });
    expect(c).toMatchObject({ contactId: "c1", phoneE164: "+923001234567", reachable: { email: true, whatsapp: false, push: false } });
  });

  it("drops baseline rows from the history: they are a starting state, not a change", () => {
    expect(parseConsentEvent({ channel: "email", from: null, to: "subscribed", reason: null, source: "baseline", createdAt: "2026-10-08T13:23:00Z" })).toBeNull();
    expect(parseConsentEvent({ channel: "email", from: "subscribed", to: "unsubscribed", reason: "unsubscribe", source: "buyer_link", createdAt: "2026-10-08T13:23:00Z" })).toMatchObject({ channel: "email", reason: "unsubscribe" });
  });
});

describe("consentView", () => {
  it("counts buyers who may be messaged per channel, merging a buyer's several contacts", () => {
    const v = consentView({
      contacts: [contact("a", "c1", { email: true }), contact("b", "c1", { whatsapp: true }), contact("c", "c2"), contact("d", null, { email: true })],
      events: [],
      buyers: 10,
    });
    expect(v).toMatchObject({ contacts: 4, matchedBuyers: 2, buyers: 10, reachableBuyers: { email: 1, whatsapp: 1, push: 0, any: 1 }, reachableContacts: { email: 2, whatsapp: 1, push: 0 } });
  });

  it("counts opt-ins and opt-outs per channel, with the reasons for leaving", () => {
    const v = consentView({
      contacts: [],
      events: [ev("email", "subscribed", "unsubscribed", "unsubscribe"), ev("email", "subscribed", "bounced", "bounce"), ev("email", "never_opted_in", "subscribed", "opt_in"), ev("email", "unsubscribed", "bounced", "bounce")],
      buyers: 0,
    });
    expect(v.changes[0]).toEqual({ channel: "email", optedIn: 1, optedOut: 2, reasons: [{ reason: "unsubscribe", count: 1 }, { reason: "bounce", count: 1 }] });
  });

  it("lists the channels each buyer may be messaged on", () => {
    expect(reachableByCustomer([contact("a", "c1", { push: true }), contact("b", "c1", { email: true })]).get("c1")).toEqual(["email", "push"]);
  });
});

describe("WhatKaBot's WhatsApp consent", () => {
  it("reads marketing as WhatsApp reachability, and keeps order updates apart", () => {
    const c = parseWhatKaBotConsent({ id: "k1", channel: "whatsapp", phone: "+923000001234", phoneRaw: "03000001234", marketing: null, marketingState: "unknown", utility: true, utilityState: "opted_in" });
    expect(c).toMatchObject({ contactId: "whatkabot:k1", reachable: { email: false, whatsapp: false, push: false }, whatsappOptOut: false, utilityIn: true });
  });

  it("lets a WhatKaBot opt-out win over a Retainify WhatsApp opt-in for the same buyer", () => {
    const retainify = contact("r", "c1", { whatsapp: true, email: true });
    const wkb = { ...contact("whatkabot:k", "c1"), whatsappOptOut: true };
    expect(consentView({ contacts: [retainify, wkb], events: [], buyers: 1 }).reachableBuyers).toMatchObject({ whatsapp: 0, email: 1, any: 1 });
    expect(reachableByCustomer([retainify, wkb]).get("c1")).toEqual(["email"]);
  });

  it("reads its marketing changes as WhatsApp opt-ins and opt-outs, skipping the baseline", () => {
    expect(parseWhatKaBotConsentEvent({ consentId: "k", channel: "whatsapp", field: "marketing", from: "opted_in", to: "opted_out", source: "stop_keyword", at: "2026-10-10T12:00:00Z" })).toMatchObject({ channel: "whatsapp", from: "subscribed", to: "unsubscribed" });
    expect(parseWhatKaBotConsentEvent({ field: "marketing", to: "opted_in", source: "baseline", at: "2026-10-10T12:00:00Z" })).toBeNull();
    expect(parseWhatKaBotConsentEvent({ field: "utility", to: "opted_out", source: "stop_keyword", at: "2026-10-10T12:00:00Z" })).toBeNull();
  });
});
