import { createECDH, randomBytes } from "node:crypto";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import webpush from "web-push";
// @ts-expect-error: no types; the decrypting side of what web-push encrypts.
import ece from "http_ece";

import { deliver } from "./deliver.server";

// A stand-in push service on localhost: it keeps what arrives and answers
// with the status the path asks for, so nothing leaves this machine.
let base = "";
const received: Array<{ path: string; headers: IncomingHttpHeaders; body: Buffer }> = [];
const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    received.push({ path: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks) });
    res.statusCode = Number((req.url ?? "").split("/")[1]) || 201;
    res.end();
  });
});
beforeAll(() => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => {
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  resolve();
})));
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

// A browser's side of a subscription, made up for the test.
const browser = createECDH("prime256v1");
browser.generateKeys();
const authSecret = randomBytes(16);
const target = (status: number) => ({ endpoint: `${base}/${status}/device`, p256dh: browser.getPublicKey("base64url"), auth: authSecret.toString("base64url") });
const keys = webpush.generateVAPIDKeys();
const vapid = { publicKey: keys.publicKey, privateKey: keys.privateKey, subject: "mailto:test@example.com" };

describe("delivering one push", () => {
  it("sends the payload encrypted for that browser alone, signed with the VAPID key", async () => {
    const payload = { title: "TCS hasn't paid for 40 delivered orders", body: "PKR 120,000", url: "/insights/x/open?to=%2Forders&from=push", id: "s1", tag: "x" };
    const r = await deliver(target(201), payload, vapid);
    expect(r).toEqual({ outcome: "delivered", status: 201, error: null });

    const got = received.at(-1)!;
    expect(got.headers["content-encoding"]).toBe("aes128gcm");
    expect(got.headers.ttl).toBe(String(8 * 60 * 60));
    expect(got.headers.authorization).toMatch(new RegExp(`^vapid t=.+, k=${keys.publicKey}$`));
    expect(got.body.toString("utf8")).not.toContain("TCS");
    const plain = ece.decrypt(got.body, { version: "aes128gcm", privateKey: browser, authSecret: authSecret.toString("base64url") }) as Buffer;
    expect(JSON.parse(plain.toString("utf8"))).toEqual(payload);
  });

  it("calls a subscription gone on 404 and 410, and a failure otherwise", async () => {
    expect((await deliver(target(410), { title: "t" }, vapid)).outcome).toBe("gone");
    expect((await deliver(target(404), { title: "t" }, vapid)).outcome).toBe("gone");
    expect((await deliver(target(429), { title: "t" }, vapid))).toMatchObject({ outcome: "failed", status: 429 });
  });

  it("treats keys no browser would give as gone, and an unreachable service as a failure", async () => {
    expect((await deliver({ ...target(201), p256dh: "bad" }, { title: "t" }, vapid)).outcome).toBe("gone");
    expect((await deliver({ ...target(201), endpoint: "http://127.0.0.1:1/x" }, { title: "t" }, vapid)).outcome).toBe("failed");
  });
});
