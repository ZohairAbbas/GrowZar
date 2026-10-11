/**
 * Consent (rule #22; PLAN.md Phase 5 D5's consent record), from Retainify's
 * current consent per contact and its history (G-GZR5-7).
 *
 * Retainify owns consent; Growzar only shows it. A buyer may be messaged on a
 * channel when Retainify says subscribed and not suppressed. Buyers are
 * matched to the store's customers by phone (Growzar's customers have no
 * email identity yet).
 *
 * WhatKaBot's WhatsApp consent joins it (G-GZR5-14): WhatKaBot sends the
 * store's WhatsApp, so its marketing opt-out wins over a Retainify opt-in on
 * that channel. Its utility consent (order updates) is reported apart: it
 * allows order messages, not marketing.
 */

export type ConsentChannel = "email" | "whatsapp" | "push";
export const CONSENT_CHANNELS: ConsentChannel[] = ["email", "whatsapp", "push"];

export type ConsentContact = {
  contactId: string;
  phoneE164: string | null;
  phoneRaw: string | null;
  /** Channels this contact may be messaged on today. */
  reachable: Record<ConsentChannel, boolean>;
  /** WhatKaBot says this number opted out of WhatsApp marketing. */
  whatsappOptOut?: boolean;
};

export type WhatKaBotConsentSummary = { numbers: number; marketingIn: number; marketingOut: number; marketingUnknown: number; utilityIn: number };

/** WhatKaBot's `MessagingConsent` row as a contact: WhatsApp only, marketing decides. */
export function parseWhatKaBotConsent(p: unknown): (ConsentContact & { utilityIn: boolean; marketingState: string }) | null {
  const r = obj(p);
  const id = str(r.id);
  if (!id) return null;
  const marketingState = str(r.marketingState) ?? (r.marketing === true ? "opted_in" : r.marketing === false ? "opted_out" : "unknown");
  return {
    contactId: `whatkabot:${id}`,
    phoneE164: str(r.phone),
    phoneRaw: str(r.phoneRaw),
    reachable: { email: false, whatsapp: marketingState === "opted_in", push: false },
    whatsappOptOut: marketingState === "opted_out",
    utilityIn: r.utility === true || r.utilityState === "opted_in",
    marketingState,
  };
}

/** WhatKaBot's consent history, marketing changes only, in the shape of Retainify's. */
export function parseWhatKaBotConsentEvent(p: unknown): ConsentEvent | null {
  const r = obj(p);
  if (r.field !== "marketing" || r.source === "baseline") return null;
  const at = typeof r.at === "string" && !Number.isNaN(Date.parse(r.at)) ? new Date(r.at) : null;
  const state = (v: unknown) => (v === "opted_in" || v === true ? "subscribed" : v === "opted_out" || v === false ? "unsubscribed" : null);
  const to = state(r.to);
  if (!at || !to) return null;
  return { channel: "whatsapp", from: state(r.from), to, reason: str(r.source), createdAt: at };
}

export type ConsentEvent = {
  channel: ConsentChannel;
  from: string | null;
  to: string;
  reason: string | null;
  createdAt: Date;
};

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const obj = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const open = (c: Record<string, unknown>) => c.state === "subscribed" && c.suppressed !== true;

export function parseConsent(p: unknown): ConsentContact | null {
  const r = obj(p);
  const contactId = str(r.contactId);
  if (!contactId) return null;
  const buyer = obj(r.buyer);
  return {
    contactId,
    phoneE164: str(buyer.phone),
    phoneRaw: str(buyer.phoneRaw),
    reachable: { email: open(obj(r.email)), whatsapp: open(obj(r.whatsapp)), push: obj(r.push).state === "subscribed" },
  };
}

/** A real change; Retainify's baseline rows (today's state when history began) are not events. */
export function parseConsentEvent(p: unknown): ConsentEvent | null {
  const r = obj(p);
  const channel = str(r.channel) as ConsentChannel | null;
  const to = str(r.to);
  const createdAt = typeof r.createdAt === "string" && !Number.isNaN(Date.parse(r.createdAt)) ? new Date(r.createdAt) : null;
  if (!channel || !CONSENT_CHANNELS.includes(channel) || !to || !createdAt || r.source === "baseline") return null;
  return { channel, from: str(r.from), to, reason: str(r.reason), createdAt };
}

export type ConsentView = {
  /** Retainify contacts for the store. */
  contacts: number;
  /** The store's buyers (customers) Growzar matched to a contact by phone. */
  matchedBuyers: number;
  buyers: number;
  /** Of the matched buyers, how many may be messaged on each channel, and on any. */
  reachableBuyers: Record<ConsentChannel | "any", number>;
  /** Of all contacts, how many may be messaged on each channel. */
  reachableContacts: Record<ConsentChannel, number>;
  /** WhatKaBot's WhatsApp consent, when it has any for the store. */
  whatkabot: WhatKaBotConsentSummary | null;
  /** Changes in the period: opted in or out, per channel, with the reasons for opting out. */
  changes: Array<{ channel: ConsentChannel; optedIn: number; optedOut: number; reasons: Array<{ reason: string; count: number }> }>;
};

const isIn = (state: string) => state === "subscribed";

export function consentView(input: {
  contacts: ReadonlyArray<ConsentContact & { customerId: string | null }>;
  events: readonly ConsentEvent[];
  buyers: number;
  whatkabot?: WhatKaBotConsentSummary | null;
}): ConsentView {
  const byCustomer = new Map<string, Record<ConsentChannel, boolean>>();
  const whatsappOut = new Set<string>();
  for (const c of input.contacts) {
    if (!c.customerId) continue;
    if (c.whatsappOptOut) whatsappOut.add(c.customerId);
    const prev = byCustomer.get(c.customerId) ?? { email: false, whatsapp: false, push: false };
    // A buyer with two contacts (two emails, one phone) may be messaged if either may.
    byCustomer.set(c.customerId, { email: prev.email || c.reachable.email, whatsapp: prev.whatsapp || c.reachable.whatsapp, push: prev.push || c.reachable.push });
  }
  // WhatKaBot's WhatsApp opt-out wins on its own channel.
  for (const id of whatsappOut) byCustomer.get(id)!.whatsapp = false;
  const reached = [...byCustomer.values()];
  const count = (pred: (r: Record<ConsentChannel, boolean>) => boolean) => reached.filter(pred).length;

  const changes = CONSENT_CHANNELS.map((channel) => {
    const evs = input.events.filter((e) => e.channel === channel);
    const out = evs.filter((e) => !isIn(e.to) && (e.from === null || isIn(e.from)));
    const reasons = new Map<string, number>();
    for (const e of out) reasons.set(e.reason ?? "not given", (reasons.get(e.reason ?? "not given") ?? 0) + 1);
    return {
      channel,
      optedIn: evs.filter((e) => isIn(e.to) && !(e.from && isIn(e.from))).length,
      optedOut: out.length,
      reasons: [...reasons.entries()].map(([reason, n]) => ({ reason, count: n })).sort((a, b) => b.count - a.count),
    };
  });

  return {
    contacts: input.contacts.length,
    whatkabot: input.whatkabot ?? null,
    matchedBuyers: byCustomer.size,
    buyers: input.buyers,
    reachableBuyers: {
      email: count((r) => r.email),
      whatsapp: count((r) => r.whatsapp),
      push: count((r) => r.push),
      any: count((r) => r.email || r.whatsapp || r.push),
    },
    reachableContacts: {
      email: input.contacts.filter((c) => c.reachable.email).length,
      whatsapp: input.contacts.filter((c) => c.reachable.whatsapp).length,
      push: input.contacts.filter((c) => c.reachable.push).length,
    },
    changes,
  };
}

/** Channels each customer may be messaged on, for the buyers table. */
export function reachableByCustomer(contacts: ReadonlyArray<ConsentContact & { customerId: string | null }>): Map<string, ConsentChannel[]> {
  const m = new Map<string, Set<ConsentChannel>>();
  const out = new Set<string>();
  for (const c of contacts) {
    if (!c.customerId) continue;
    if (c.whatsappOptOut) out.add(c.customerId);
    const s = m.get(c.customerId) ?? new Set<ConsentChannel>();
    for (const ch of CONSENT_CHANNELS) if (c.reachable[ch]) s.add(ch);
    m.set(c.customerId, s);
  }
  for (const id of out) m.get(id)?.delete("whatsapp");
  return new Map([...m.entries()].map(([k, s]) => [k, CONSENT_CHANNELS.filter((ch) => s.has(ch))]));
}
