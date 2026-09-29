/**
 * G-GZR2-1 acceptance: the shipment event log, against the real Courierify.
 *
 *   DATABASE_POOL=1 npx tsx --env-file=.env mocks/acceptance-g-gzr2-1.mts [shop]
 *
 * Unlike the Phase 1 scripts this runs against the live app, not a mock — the
 * mock was built from the same reading of the contract as the code, and the
 * point is to find where the two disagree. The store must already exist in
 * whatever database DATABASE_URL names, with Courierify connected.
 *
 * The three acceptance criteria, plus the numbers the report needs:
 *   1. replaying stored events reproduces each parcel's current status
 *   2. a second run writes nothing new
 *   3. courierEventAt is null wherever Courierify sent null, never filled in
 *   +  rows, bytes per row, pages, time, per-courier coverage
 *
 * Buyer fields are never read: from /shipments it keeps id, status, courier.
 */
import { prisma } from "../app/lib/db.server.ts";
import { appRequest } from "../app/lib/apps/client.server.ts";
import { getAppCredentials } from "../app/lib/apps/registry.server.ts";
import { syncFeed } from "../app/lib/sync/sync.server.ts";
import { feedsFor } from "../app/lib/sync/entities.ts";
import {
  courierCoverage,
  currentStatusTiming,
  eventKeyOf,
  replayStatus,
} from "../app/lib/shipments/events.ts";

const shopDomain = (process.argv[2] ?? "whatsapp-check.myshopify.com").toLowerCase();

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  if (!ok) failures += 1;
  console.log(`   ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

const credentials = getAppCredentials("COURIERIFY");
if (!credentials) throw new Error("No Courierify credentials in this environment");

const store = await prisma.store.findUnique({ where: { shopDomain } });
if (!store) throw new Error(`No store ${shopDomain} in this database`);

const feed = feedsFor("COURIERIFY").find((f) => f.entity === "SHIPMENT_EVENT")!;

/** Walk a Courierify list endpoint to the end, keeping only what `pick` returns. */
async function walk<T>(path: string, pick: (row: any) => T): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  do {
    const q = new URLSearchParams({ limit: "500" });
    if (cursor) q.set("cursor", cursor);
    const r = await appRequest<any>("COURIERIFY", {
      pathWithQuery: `${path}?${q}`,
      shopDomain,
      credentials: credentials!,
    });
    if (!r.ok) throw new Error(`${path}: ${r.reason} ${r.message}`);
    for (const row of r.data.data ?? []) out.push(pick(row));
    cursor = r.data.pagination?.hasMore ? r.data.pagination.nextCursor : null;
  } while (cursor);
  return out;
}

console.log(`\nG-GZR2-1 against ${shopDomain}\n`);

// ── 1. First run, to completion ─────────────────────────────────────────────
console.log("1. Ingest");
const started = Date.now();
let runs = 0, pages = 0, written = 0, duplicates = 0, skipped = 0;
for (;;) {
  const result = await syncFeed({ storeId: store.id, shopDomain, app: "COURIERIFY", feed });
  runs += 1;
  if (result.error) throw new Error(`sync failed: ${result.error}`);
  pages += result.pages;
  written += result.written;
  duplicates += result.duplicates;
  skipped += result.skipped;
  if (result.finished) break;
}
const elapsedMs = Date.now() - started;
console.log(
  `   runs=${runs} pages=${pages} written=${written} duplicates=${duplicates} rejected=${skipped} time=${elapsedMs}ms`,
);
check("no row rejected by the parser", skipped === 0, `${skipped} rejected`);

// ── 2. Second run ───────────────────────────────────────────────────────────
console.log("\n2. A second run");
const again = await syncFeed({ storeId: store.id, shopDomain, app: "COURIERIFY", feed });
check(
  "writes nothing new",
  !again.error && again.written === 0,
  `written=${again.written}, re-read ${again.duplicates} inside the 5-minute overlap`,
);

// ── 3. Stored vs sent, event by event ───────────────────────────────────────
console.log("\n3. Stored rows against the feed");
const sent = await walk("/api/v1/growzar/shipment-events", (e) => ({
  id: String(e.id),
  shipmentId: String(e.shipmentId),
  status: String(e.status),
  courierEventAt: e.courierEventAt as string | null,
  observedAt: String(e.observedAt),
}));
const stored = await prisma.shipmentEvent.findMany({ where: { storeId: store.id } });
const byKey = new Map(stored.map((s) => [`${s.shipmentId}#${s.eventKey}`, s]));

let missing = 0, collapsed = 0, filledIn = 0, lost = 0;
for (const e of sent) {
  const key = eventKeyOf(
    e.status,
    e.courierEventAt ? new Date(e.courierEventAt) : null,
    new Date(e.observedAt),
  );
  const row = byKey.get(`${e.shipmentId}#${key}`);
  if (!row) { missing += 1; continue; }
  if (row.sourceEventId.toString() !== e.id) collapsed += 1;
  if (e.courierEventAt === null && row.courierEventAt !== null) filledIn += 1;
  if (e.courierEventAt !== null && row.courierEventAt?.getTime() !== new Date(e.courierEventAt).getTime()) lost += 1;
}
const nullSent = sent.filter((e) => e.courierEventAt === null).length;
check("every event the feed sends is stored", missing === 0, `${sent.length} sent, ${missing} missing`);
check(
  "courierEventAt null wherever Courierify sent null",
  filledIn === 0,
  `${nullSent} sent null, ${filledIn} stored with a time`,
);
check("courierEventAt kept wherever Courierify sent one", lost === 0, `${lost} differ`);
console.log(`   ${collapsed} feed event(s) share a key with another event (same status, times) and collapsed into it`);

// ── 4. Replay ───────────────────────────────────────────────────────────────
console.log("\n4. Replay reproduces each parcel's current status");
const parcels = await walk("/api/v1/growzar/shipments", (p) => ({
  id: String(p.id),
  status: String(p.status),
  courier: (p.courier ?? null) as string | null,
}));
const eventsByShipment = new Map<string, typeof stored>();
for (const s of stored) {
  const list = eventsByShipment.get(s.shipmentId) ?? [];
  list.push(s);
  eventsByShipment.set(s.shipmentId, list);
}

const mismatches: string[] = [];
let noEvents = 0, happenedOn = 0, asOf = 0;
for (const p of parcels) {
  const events = eventsByShipment.get(p.id) ?? [];
  if (!events.length) { noEvents += 1; continue; }
  const replayed = replayStatus(events);
  if (replayed !== p.status) mismatches.push(`${p.id}: replay=${replayed} parcel=${p.status}`);
  const timing = currentStatusTiming(events);
  if (timing?.basis === "happened_on") happenedOn += 1;
  else asOf += 1;
}
check(
  "replay matches /shipments for every parcel with events",
  mismatches.length === 0,
  `${parcels.length - noEvents} parcels compared, ${mismatches.length} differ${mismatches.length ? `: ${mismatches.slice(0, 5).join("; ")}` : ""}`,
);
check("every parcel has at least one event", noEvents === 0, `${noEvents} without`);
console.log(`   current status: ${happenedOn} "happened on" (courier time), ${asOf} "status as of"`);

// ── 5. Coverage and size ────────────────────────────────────────────────────
console.log("\n5. Per-courier coverage");
for (const c of courierCoverage(parcels.map((p) => ({ courier: p.courier, events: eventsByShipment.get(p.id) ?? [] })))) {
  console.log(
    `   ${c.courier.padEnd(12)} parcels=${String(c.parcels).padStart(5)} timed=${String(c.parcelsWithCourierTime).padStart(5)}  ${c.verdict}${c.verdict === "not_enough_data" ? ` (${c.reason})` : ""}`,
  );
}

console.log("\n6. Size");
const [size] = await prisma.$queryRaw<Array<{ rows: bigint; total: bigint; heap: bigint }>>`
  SELECT count(*)::bigint AS rows,
         pg_total_relation_size('shipment_events')::bigint AS total,
         pg_relation_size('shipment_events')::bigint AS heap
  FROM shipment_events`;
const rows = Number(size!.rows);
console.log(
  `   table rows=${rows} total=${size!.total} B heap=${size!.heap} B` +
    (rows ? ` (${Math.round(Number(size!.total) / rows)} B/row incl. indexes, small-table overhead dominates)` : ""),
);

await prisma.$disconnect();
console.log(failures ? `\n${failures} check(s) FAILED\n` : "\nAll checks passed\n");
process.exit(failures ? 1 : 0);
