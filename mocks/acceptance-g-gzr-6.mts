/**
 * G-GZR-6 acceptance: the customer record and the shell's section states.
 *
 * Needs both mock apps running and the environment that points Growzar at
 * them. Seeds orders whose buyers differ only in how their phone is written,
 * syncs, and checks they resolve to one person.
 */
import { prisma } from "../app/lib/db.server.ts";
import { syncStore } from "../app/lib/sync/sync.server.ts";
import { SECTION_DEFINITIONS, sectionState } from "../app/lib/sections.server.ts";
import { SECTIONS } from "../app/lib/permissions.ts";

const CFY = process.env.CFY ?? "http://127.0.0.1:4010";
const FIN = process.env.FIN ?? "http://127.0.0.1:4011";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  if (!ok) failures += 1;
  console.log(`   ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

const seed = (base: string, shop: string, path: string, rows: unknown[]) =>
  fetch(`${base}/__seed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ shop, path, rows, reset: true }),
  });

let orgCounter = 0;

async function makeStore(shop: string, apps: ("COURIERIFY" | "FINANCIFY")[]) {
  const stamp = `${Date.now()}-${(orgCounter += 1)}`;
  const org = await prisma.organization.create({
    data: { name: `Cust ${stamp}`, slug: `cust-${stamp}`, baseCurrency: "PKR" },
  });
  const store = await prisma.store.create({
    data: { organizationId: org.id, shopDomain: shop },
  });
  for (const app of apps) {
    await prisma.appConnection.create({
      data: { storeId: store.id, app, status: "CONNECTED", connectedAt: new Date() },
    });
    await fetch(`${app === "COURIERIFY" ? CFY : FIN}/__install?shop=${shop}`);
  }
  return store;
}

async function main() {
  const stamp = Date.now();
  const shop = `cust-${stamp}.myshopify.com`;
  const store = await makeStore(shop, ["COURIERIFY"]);

  console.log("\n1. buyers who differ only in phone format resolve to one customer");

  const iso = (i: number) => new Date(Date.UTC(2026, 8, 1, 0, 0, i)).toISOString();
  // One person, six orders, six spellings. Courierify would count six
  // customers here, because it groups by the raw string.
  const spellings = [
    "+923001234567",
    "+92 300 1234567",
    "0300-1234567",
    "03001234567",
    "+92-300-1234567",
    "  +92 (300) 123 4567  ",
  ];

  await seed(
    CFY,
    shop,
    "/api/v1/orders",
    spellings.map((phone, i) => ({
      id: String(9000000000000 + i),
      orderId: String(9000000000000 + i),
      updatedAt: iso(i),
      customerPhone: phone,
      customerName: "Ayesha Khan",
      total: { amount: "4500.00", currency: "PKR" },
    })),
  );

  await syncStore(store.id);

  const customers = await prisma.customer.findMany({
    where: { storeId: store.id, mergedIntoId: null },
    include: { identities: true },
  });

  check("six orders, six spellings, one customer", customers.length === 1,
    `${customers.length} customer(s)`);
  check("stored in E.164",
    customers[0]?.identities[0]?.value === "+923001234567",
    String(customers[0]?.identities[0]?.value));
  check("the raw spelling is kept beside it",
    customers[0]?.identities[0]?.raw !== null);

  const fresh = await prisma.store.findUnique({ where: { id: store.id } });
  check("the store's country was learned for local-format numbers",
    fresh?.country === "PK", `${fresh?.country} (inferred: ${fresh?.countryInferred})`);

  console.log("\n2. two different buyers stay two customers");
  await seed(CFY, shop, "/api/v1/orders", [
    {
      id: "9100000000001", orderId: "9100000000001", updatedAt: iso(100),
      customerPhone: "0301-7654321", customerName: "Bilal Ahmed",
      total: { amount: "1200.00", currency: "PKR" },
    },
  ]);
  await syncStore(store.id);
  const twoPeople = await prisma.customer.count({
    where: { storeId: store.id, mergedIntoId: null },
  });
  check("a different number is a different person", twoPeople === 2, String(twoPeople));

  console.log("\n3. a buyer known by phone, then by email, then by both, merges");
  await seed(CFY, shop, "/api/v1/orders", [
    {
      id: "9200000000001", orderId: "9200000000001", updatedAt: iso(200),
      customerEmail: "ayesha@example.pk", customerName: "Ayesha K",
      total: { amount: "900.00", currency: "PKR" },
    },
  ]);
  await syncStore(store.id);
  const beforeMerge = await prisma.customer.count({
    where: { storeId: store.id, mergedIntoId: null },
  });
  check("the email-only order is a third person so far", beforeMerge === 3,
    String(beforeMerge));

  // Now an order carrying BOTH identities: they are one person after all.
  await seed(CFY, shop, "/api/v1/orders", [
    {
      id: "9300000000001", orderId: "9300000000001", updatedAt: iso(300),
      customerPhone: "+923001234567", customerEmail: "ayesha@example.pk",
      customerName: "Ayesha Khan",
      total: { amount: "2000.00", currency: "PKR" },
    },
  ]);
  await syncStore(store.id);

  const afterMerge = await prisma.customer.count({
    where: { storeId: store.id, mergedIntoId: null },
  });
  check("the two records were merged into one", afterMerge === 2, String(afterMerge));

  const merged = await prisma.customer.findFirst({
    where: { storeId: store.id, mergedIntoId: { not: null } },
  });
  check("the merged record is kept, not deleted, so old numbers stay explicable",
    merged !== null);

  console.log("\n4. a phone Growzar cannot parse is kept, not invented");
  await seed(CFY, shop, "/api/v1/orders", [
    {
      id: "9400000000001", orderId: "9400000000001", updatedAt: iso(400),
      customerPhone: "call the shop", customerName: "Walk-in",
      total: { amount: "500.00", currency: "PKR" },
    },
  ]);
  const withRubbish = await syncStore(store.id);
  const reported = withRubbish.reduce((n, r) => n + r.unparseablePhones, 0);
  check("the unparseable number was counted and reported", reported > 0,
    `${reported} reported`);
  const stillTwo = await prisma.customer.count({
    where: { storeId: store.id, mergedIntoId: null },
  });
  check("it did not become a phantom customer", stillTwo === 2, String(stillTwo));

  console.log("\n5. the shell locks the right sections for each kind of store");

  const shapes = [
    { name: "Courierify only", apps: ["COURIERIFY"] as const },
    { name: "Financify only", apps: ["FINANCIFY"] as const },
    { name: "both apps", apps: ["COURIERIFY", "FINANCIFY"] as const },
  ];

  for (const shape of shapes) {
    const shopFor = `shape-${shape.apps.join("-").toLowerCase()}-${stamp}.myshopify.com`;
    const s = await makeStore(shopFor, [...shape.apps]);
    const connections = await prisma.appConnection.findMany({
      where: { storeId: s.id },
      select: { app: true, status: true, lastSyncedAt: true },
    });

    const states = Object.fromEntries(
      SECTIONS.map((section) => [
        section,
        sectionState(SECTION_DEFINITIONS[section], connections).kind,
      ]),
    );

    console.log(
      `      ${shape.name}: ` +
        SECTIONS.map((x) => `${x}=${states[x]}`).join(" "),
    );

    check(`${shape.name}: Home and Settings are always open`,
      states.home === "open" && states.settings === "open");

    if (shape.apps.includes("COURIERIFY")) {
      check(`${shape.name}: Shipping is open`, states.shipping === "open");
    } else {
      check(`${shape.name}: Shipping is locked, not hidden`, states.shipping === "locked");
    }

    if (shape.apps.includes("FINANCIFY")) {
      check(`${shape.name}: Finance and Marketing are open`,
        states.finance === "open" && states.marketing === "open");
    } else {
      check(`${shape.name}: Finance and Marketing are locked`,
        states.finance === "locked" && states.marketing === "locked");
    }

    check(`${shape.name}: Inbox is locked without WhatKaBot`, states.inbox === "locked");
    check(`${shape.name}: Inventory is locked without Inventorify`,
      states.inventory === "locked");
  }

  console.log("\n6. an uninstalled app is 'reconnect', not 'locked' (D-17)");
  const reconnectShop = `reconnect-${stamp}.myshopify.com`;
  const reconnectStore = await makeStore(reconnectShop, ["COURIERIFY"]);
  await prisma.appConnection.updateMany({
    where: { storeId: reconnectStore.id, app: "COURIERIFY" },
    data: {
      status: "DISCONNECTED",
      lastSyncedAt: new Date("2026-09-20T00:00:00Z"),
      disconnectedAt: new Date(),
      purgeAfter: new Date(Date.now() + 30 * 864e5),
    },
  });
  const rc = await prisma.appConnection.findMany({
    where: { storeId: reconnectStore.id },
    select: { app: true, status: true, lastSyncedAt: true },
  });
  const shippingState = sectionState(SECTION_DEFINITIONS.shipping, rc);
  check("Shipping says reconnect, not connect-this-app",
    shippingState.kind === "reconnect", shippingState.kind);
  check("it carries the date the data was last true",
    shippingState.kind === "reconnect" && shippingState.asOf !== null);

  console.log(
    `\n${failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`}\n`,
  );
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
