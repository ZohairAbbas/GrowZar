/**
 * Push notifications against Postgres (pre-Wave-1 pack 4), in a private
 * schema of growzar_shadow (app/lib/books/__tests__/test-db.ts), with a
 * stand-in push service on localhost. Runs only with BOOKS_TEST_DATABASE_URL:
 *
 *   BOOKS_TEST_DATABASE_URL=$SHADOW_DATABASE_URL npx vitest run app/lib/push --no-file-parallelism
 *
 * The run's weekly digest push needs no store data (a store that never synced
 * is skipped for findings), so it carries the end-to-end checks: who gets a
 * real push and who a dry run, quiet hours, the cap, no repeats, and a device
 * the push service calls gone being deleted.
 */
import { createECDH, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import webpush from "web-push";

import { TEST_DATABASE_URL, openTestSchema } from "../books/__tests__/test-db";

const run = TEST_DATABASE_URL ? describe : describe.skip;

run("push notifications against Postgres", () => {
  let dropSchema: (() => Promise<void>) | undefined;
  let P: typeof import("./push.server");
  let prisma: import("@prisma/client").PrismaClient;
  let base = "";
  const hits: string[] = [];
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      hits.push(req.url ?? "");
      res.statusCode = Number((req.url ?? "").split("/")[1]) || 201;
      res.end();
    });
  });

  const org = `push-${Date.now()}`;
  const ids = { owner: `${org}-owner`, staff: `${org}-staff` };
  // Monday 2026-11-02 in Karachi (UTC+5): 10:00 is inside the weekly slot, 23:00 is quiet.
  const monday10 = new Date("2026-11-02T05:00:00Z");
  const monday23 = new Date("2026-11-02T18:00:00Z");
  const browser = createECDH("prime256v1");
  browser.generateKeys();
  const device = (status: number, n: string) => ({
    endpoint: `${base}/${status}/${n}`,
    p256dh: browser.getPublicKey("base64url"),
    auth: randomBytes(16).toString("base64url"),
  });

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const keys = webpush.generateVAPIDKeys();
    Object.assign(process.env, {
      PUSH_SENDING: "internal",
      PUSH_VAPID_PUBLIC: keys.publicKey,
      PUSH_VAPID_PRIVATE: keys.privateKey,
      PUSH_SUBJECT: "mailto:test@example.com",
      INTERNAL_EMAILS: `${ids.owner}@example.com`,
    });
    dropSchema = await openTestSchema({ all: true });
    ({ prisma } = await import("~/lib/db.server"));
    P = await import("./push.server");

    await prisma.organization.create({ data: { id: org, name: "Demo Traders", slug: org, baseCurrency: "PKR", createdAt: new Date() } });
    await prisma.store.create({ data: { id: `${org}-store`, organizationId: org, shopDomain: `${org}.myshopify.com`, displayName: "Demo Store", timezone: "Asia/Karachi" } });
    for (const [role, id] of [["owner", ids.owner], ["staff", ids.staff]] as const) {
      await prisma.user.create({ data: { id, name: role, email: `${id}@example.com`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() } });
      await prisma.member.create({ data: { id, organizationId: org, userId: id, role, createdAt: new Date() } });
      // Monday's digest went out (or would have): what the digest push follows.
      await prisma.digestSend.create({
        data: {
          organizationId: org, memberId: id, userId: id, email: `${id}@example.com`, week: "2026-11-02",
          mode: role === "owner" ? "live" : "dry_run", status: role === "owner" ? "sent" : "dry_run", dedupeKey: `${id}:2026-11-02`,
          content: [{ storeId: `${org}-store`, name: "Demo Store", skipped: null, items: [{}, {}], app: null, results: [] }],
        },
      });
    }
    await prisma.pushSubscription.createMany({
      data: [
        { memberId: ids.owner, ...device(201, "owner-phone") },
        { memberId: ids.owner, ...device(410, "owner-old-laptop") },
        { memberId: ids.staff, ...device(201, "staff-phone") },
      ],
    });
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await dropSchema?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("sends nothing in the quiet hours", async () => {
    expect(await P.runDuePushes(monday23)).toEqual({ sent: 0, dryRun: 0, failed: 0 });
    expect(await prisma.pushSend.count()).toBe(0);
    expect(hits).toEqual([]);
  });

  it("sends the internal owner a real push and logs a dry run for staff, and drops the device that's gone", async () => {
    expect(await P.runDuePushes(monday10)).toEqual({ sent: 1, dryRun: 1, failed: 0 });
    const sends = await prisma.pushSend.findMany({ orderBy: { memberId: "asc" } });
    expect(sends.map((s) => [s.memberId, s.kind, s.mode, s.status, s.delivered, s.day])).toEqual([
      [ids.owner, "digest", "live", "sent", 1, "2026-11-02"],
      [ids.staff, "digest", "dry_run", "dry_run", 0, "2026-11-02"],
    ]);
    expect(sends[0]!.title).toBe("2 things need your attention at Demo Store");
    expect(sends[0]!.url).toBe("/home?from=push");
    expect(hits.sort()).toEqual(["/201/owner-phone", "/410/owner-old-laptop"]);
    const left = await prisma.pushSubscription.findMany({ select: { endpoint: true, lastSuccessAt: true } });
    expect(left.map((d) => d.endpoint.split("/").pop()).sort()).toEqual(["owner-phone", "staff-phone"]);
    expect(left.find((d) => d.endpoint.endsWith("owner-phone"))!.lastSuccessAt).not.toBeNull();
  });

  it("never sends the same thing twice", async () => {
    hits.length = 0;
    expect(await P.runDuePushes(new Date(monday10.getTime() + 10 * 60_000))).toEqual({ sent: 0, dryRun: 0, failed: 0 });
    expect(hits).toEqual([]);
  });

  it("stops at 2 a day", async () => {
    await prisma.pushSend.deleteMany({ where: { memberId: ids.owner } });
    for (const n of [1, 2]) {
      await prisma.pushSend.create({
        data: { organizationId: org, memberId: ids.owner, userId: ids.owner, kind: "cash_held", mode: "live", day: "2026-11-02", dedupeKey: `cap-${n}`, status: "sent", title: "t", body: "b", url: "/" },
      });
    }
    expect(await P.runDuePushes(monday10)).toEqual({ sent: 0, dryRun: 0, failed: 0 });
    expect(await prisma.pushSend.count({ where: { memberId: ids.owner, kind: "digest" } })).toBe(0);
  });

  it("sends a test whatever the cap, and counts a click only from the member it went to", async () => {
    const r = await P.sendTestPush({ organizationId: org, memberId: ids.owner, userId: ids.owner }, "Asia/Karachi");
    expect(r).toMatchObject({ status: "sent", delivered: 1, devices: 1 });
    const test = await prisma.pushSend.findFirstOrThrow({ where: { kind: "test" } });
    await P.recordPushClick(test.id, ids.staff);
    expect((await prisma.pushSend.findUniqueOrThrow({ where: { id: test.id } })).clickedAt).toBeNull();
    await P.recordPushClick(test.id, ids.owner);
    expect((await prisma.pushSend.findUniqueOrThrow({ where: { id: test.id } })).clickedAt).not.toBeNull();
  });

  it("refuses a subscription that isn't an https push service", () => {
    expect(P.parseSubscription(JSON.stringify({ endpoint: "http://127.0.0.1/x", keys: { p256dh: "a", auth: "b" } }))).toBeNull();
    expect(P.parseSubscription("not json")).toBeNull();
    expect(P.parseSubscription(JSON.stringify({ endpoint: "https://fcm.googleapis.com/fcm/send/x", keys: { p256dh: "a", auth: "b" } }))).toEqual({
      endpoint: "https://fcm.googleapis.com/fcm/send/x",
      keys: { p256dh: "a", auth: "b" },
    });
  });
});
