import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

/**
 * public/sw.js's push handlers (pre-Wave-1 pack 4), run in a sandbox with a
 * stand-in `self`: what a push shows, and where a click goes.
 */
const SOURCE = readFileSync(fileURLToPath(new URL("../../../public/sw.js", import.meta.url)), "utf8");

function worker(windows: Array<{ url: string }> = []) {
  const handlers: Record<string, (e: unknown) => void> = {};
  const calls = { shown: [] as unknown[], fetched: [] as Array<{ url: string; body: string }>, opened: [] as string[], navigated: [] as string[], focused: 0 };
  const clients = windows.map((w) => ({
    url: w.url,
    focus: async () => void (calls.focused += 1),
    navigate: async (to: string) => void calls.navigated.push(to),
  }));
  const self = {
    location: { origin: "https://portal.example" },
    addEventListener: (type: string, fn: (e: unknown) => void) => (handlers[type] = fn),
    registration: { showNotification: async (title: string, options: unknown) => void calls.shown.push({ title, options }) },
    clients: { matchAll: async () => clients, openWindow: async (to: string) => void calls.opened.push(to), claim: async () => undefined },
    skipWaiting: async () => undefined,
  };
  const fetch = async (url: string, init: { body: URLSearchParams }) => {
    calls.fetched.push({ url, body: String(init.body) });
    return {};
  };
  runInNewContext(SOURCE, { self, caches: {}, fetch, URL, URLSearchParams, Request: class {}, Promise, JSON });
  const fire = async (type: string, event: object) => {
    let wait: Promise<unknown> = Promise.resolve();
    handlers[type]!({ ...event, waitUntil: (p: Promise<unknown>) => (wait = p) });
    await wait;
  };
  return { fire, calls };
}

const data = (v: object) => ({ data: { json: () => v, text: () => JSON.stringify(v) } });
const click = (d: object) => {
  let closed = false;
  return { notification: { data: d, close: () => (closed = true) }, closed: () => closed };
};

describe("the service worker's push handlers", () => {
  it("shows a push as the server worded it, with Growzar's icon", async () => {
    const w = worker();
    await w.fire("push", data({ title: "TCS hasn't paid for 40 delivered orders", body: "PKR 120,000", url: "/insights/i/open?to=%2Forders&from=push", id: "s1", tag: "i" }));
    expect(w.calls.shown).toEqual([
      {
        title: "TCS hasn't paid for 40 delivered orders",
        options: { body: "PKR 120,000", icon: "/icons/growzar-192.png", tag: "i", data: { url: "/insights/i/open?to=%2Forders&from=push", id: "s1" } },
      },
    ]);
  });

  it("still shows something for a payload it can't read", async () => {
    const w = worker();
    await w.fire("push", { data: { json: () => { throw new Error("not json"); }, text: () => "hello" } });
    expect(w.calls.shown).toMatchObject([{ title: "Growzar", options: { body: "hello", data: { url: "/home" } } }]);
  });

  it("reports the click, then opens the page in the window Growzar already has", async () => {
    const w = worker([{ url: "https://portal.example/finance" }]);
    const c = click({ url: "/books/drafts?from=push", id: "s2" });
    await w.fire("notificationclick", c);
    expect(c.closed()).toBe(true);
    expect(w.calls.fetched).toEqual([{ url: "/api/push/click", body: "id=s2" }]);
    expect(w.calls.focused).toBe(1);
    expect(w.calls.navigated).toEqual(["https://portal.example/books/drafts?from=push"]);
    expect(w.calls.opened).toEqual([]);
  });

  it("opens a new window when Growzar isn't open", async () => {
    const w = worker();
    await w.fire("notificationclick", click({ url: "/home?from=push", id: "s3" }));
    expect(w.calls.opened).toEqual(["https://portal.example/home?from=push"]);
  });

  it("never opens another site's address", async () => {
    const w = worker();
    await w.fire("notificationclick", click({ url: "https://elsewhere.example/x", id: "s4" }));
    expect(w.calls.opened).toEqual([]);
    expect(w.calls.fetched).toEqual([]);
  });
});
