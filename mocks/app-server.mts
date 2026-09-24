/**
 * A contract-conformant stand-in for a suite app.
 *
 * Courierify's Growzar-facing surface (G-CFY-2) and Financify's per-order rows
 * land in parallel with this work, and neither exists on this box yet. Rather
 * than leave G-GZR-3 to G-GZR-5 unverified until they do, this server
 * implements the app side of `contracts/API-CONTRACT.md` exactly as written,
 * and Growzar is pointed at it.
 *
 * It is a test harness, not a fake app: it deliberately implements the
 * contract's *rules* rather than a convenient subset, so that the awkward
 * parts — signature verification, the `(updatedAt, id)` cursor, tombstones,
 * `Retry-After` — are exercised before the real apps arrive. Where it refuses
 * something, the real app is meant to refuse it too.
 *
 *   node --experimental-strip-types mocks/app-server.mts
 *
 * Environment:
 *   MOCK_APP        courierify | financify | …   (default courierify)
 *   MOCK_PORT       default 4010
 *   MOCK_SECRET     the app's Growzar signing secret (HMAC and claim tokens)
 *   MOCK_KEY        the platform bearer key Growzar will send
 *   MOCK_INSTALLED  comma-separated shop domains this app is installed on
 */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const APP = process.env.MOCK_APP ?? "courierify";
const PORT = Number(process.env.MOCK_PORT ?? 4010);
const SECRET = process.env.MOCK_SECRET ?? "mock-signing-secret";
const KEY = process.env.MOCK_KEY ?? "mock-platform-key";
const INSTALLED = new Set(
  (process.env.MOCK_INSTALLED ?? "")
    .split(",")
    .map((shop) => shop.trim().toLowerCase())
    .filter(Boolean),
);

const SKEW_MS = 5 * 60 * 1000;

const base64url = (input: Buffer | string) =>
  Buffer.from(input).toString("base64url");

function json(res: import("node:http").ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    // §9: CORS stays closed on authenticated endpoints. Financify sets `*`
    // today, which exposes a pasted key to any page; the mock does not, so a
    // browser-side mistake fails here the same way it would in production.
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function error(
  res: import("node:http").ServerResponse,
  status: number,
  errorType: string,
  message: string,
) {
  json(res, status, { error: message, errorType });
}

/** §2.1, from the app's side. The bearer key alone is never sufficient. */
function verifyGrowzarRequest(
  req: import("node:http").IncomingMessage,
  rawBody: string,
): { ok: true } | { ok: false; status: number; type: string; message: string } {
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${KEY}`) {
    return {
      ok: false,
      status: 401,
      type: "unauthorized",
      message: "Bad or missing platform key.",
    };
  }

  const signature = req.headers["x-growzar-signature"];
  const timestamp = req.headers["x-growzar-timestamp"];

  if (typeof signature !== "string" || typeof timestamp !== "string") {
    return {
      ok: false,
      status: 401,
      type: "unauthorized",
      message: "Missing signature headers.",
    };
  }

  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt) || Math.abs(Date.now() - sentAt) > SKEW_MS) {
    return {
      ok: false,
      status: 401,
      type: "unauthorized",
      message: "Timestamp outside the 5-minute window.",
    };
  }

  const payload = `${sentAt}.${(req.method ?? "GET").toUpperCase()} ${req.url}.${rawBody}`;
  const expected = `sha256=${createHmac("sha256", SECRET).update(payload).digest("hex")}`;

  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return {
      ok: false,
      status: 401,
      type: "unauthorized",
      message: "Signature did not match.",
    };
  }

  return { ok: true };
}

/** §10. HS256, aud growzar, exp = iat + 300, a fresh jti every time. */
function mintClaimToken(options: {
  shop: string;
  email: string;
  isStoreOwner: boolean;
  jti?: string;
  expiresInSeconds?: number;
  audience?: string;
  secret?: string;
}) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64url(
    JSON.stringify({
      iss: APP,
      aud: options.audience ?? "growzar",
      shop: options.shop,
      shopifyUserId: "gid://shopify/StaffMember/123",
      email: options.email,
      isStoreOwner: options.isStoreOwner,
      locale: "en",
      jti: options.jti ?? randomUUID(),
      iat: now,
      exp: now + (options.expiresInSeconds ?? 300),
    }),
  );
  const signature = createHmac("sha256", options.secret ?? SECRET)
    .update(`${header}.${body}`)
    .digest("base64url");

  return `${header}.${body}.${signature}`;
}

/**
 * §6 list endpoints.
 *
 * The rows live in memory and are seeded through `/__seed`. Ordering is
 * `(updatedAt, id)` ascending — the second key is mandatory (§6.2), and
 * ordering on `updatedAt` alone is a live bug in Courierify's
 * `/inventrify/order-outcomes` that stalls forever on a cluster of rows
 * sharing a timestamp. This mock orders correctly so Growzar's cursor walk is
 * exercised against a conforming app; the real one is a finding for the report.
 */
type Row = { id: string; updatedAt: string; [key: string]: unknown };

const LIST_PATHS = new Set([
  "/api/v1/orders",
  "/api/v1/shipments",
  "/api/v1/settlements",
  "/api/v1/costs",
]);

/** shop -> path -> rows, and the tombstones reported alongside them. */
const rows = new Map<string, Map<string, Row[]>>();
const tombstones = new Map<string, Map<string, string[]>>();

function bucket<T>(map: Map<string, Map<string, T[]>>, shop: string, path: string): T[] {
  let byPath = map.get(shop);
  if (!byPath) {
    byPath = new Map();
    map.set(shop, byPath);
  }
  let list = byPath.get(path);
  if (!list) {
    list = [];
    byPath.set(path, list);
  }
  return list;
}

const byUpdatedAtThenId = (a: Row, b: Row) =>
  a.updatedAt === b.updatedAt
    ? a.id < b.id
      ? -1
      : a.id > b.id
        ? 1
        : 0
    : a.updatedAt < b.updatedAt
      ? -1
      : 1;

/** The cursor is opaque to Growzar; here it is the last (updatedAt, id) seen. */
const encodeCursor = (row: Row) =>
  Buffer.from(`${row.updatedAt}|${row.id}`).toString("base64url");

function afterCursor(list: Row[], cursor: string | null): Row[] {
  if (!cursor) return list;
  const [updatedAt, id] = Buffer.from(cursor, "base64url")
    .toString("utf8")
    .split("|");
  if (!updatedAt || !id) return list;
  return list.filter(
    (row) => row.updatedAt > updatedAt || (row.updatedAt === updatedAt && row.id > id),
  );
}

function listEndpoint(
  res: import("node:http").ServerResponse,
  url: URL,
  req: import("node:http").IncomingMessage,
) {
  const shop = String(req.headers["x-growzar-shop"] ?? "").toLowerCase();

  // A one-shot 429 with Retry-After, so the client's handling of it can be
  // driven from a test. Set with /__rate-limit.
  const pending = rateLimitOnce.get(shop);
  if (pending) {
    rateLimitOnce.delete(shop);
    res.writeHead(429, {
      "content-type": "application/json",
      "retry-after": String(pending),
    });
    return res.end(
      JSON.stringify({ error: "Slow down.", errorType: "rate_limited" }),
    );
  }

  // Fault injection: fail the next N list calls with a 500. Set high enough to
  // exhaust the client's retries and the run aborts mid-walk, which is what a
  // killed worker looks like from the database's point of view — and is far
  // more testable than actually killing one.
  const fault = failNext.get(shop);
  if (fault && fault.after > 0) {
    fault.after -= 1;
  } else if (fault && fault.count > 0) {
    fault.count -= 1;
    res.writeHead(500, { "content-type": "application/json" });
    return res.end(
      JSON.stringify({ error: "Injected failure.", errorType: "internal_error" }),
    );
  }

  const all = [...bucket(rows, shop, url.pathname)].sort(byUpdatedAtThenId);

  const updatedSince = url.searchParams.get("updatedSince");
  // §6.2: `updatedSince` is INCLUSIVE, so the boundary row repeats and Growzar
  // is expected to deduplicate it. Making it exclusive here would hide a bug
  // in Growzar rather than expose one.
  const filtered = updatedSince
    ? all.filter((row) => row.updatedAt >= updatedSince)
    : all;

  const cursor = url.searchParams.get("cursor");
  const remaining = afterCursor(filtered, cursor);

  const limit = Math.min(Number(url.searchParams.get("limit") ?? 200), 200);
  const page = remaining.slice(0, limit);
  const hasMore = remaining.length > page.length;
  const last = page[page.length - 1];

  return json(res, 200, {
    shop,
    shopTimezone: "Asia/Karachi",
    shopCurrency: "PKR",
    data: page,
    // §6.2: deletions are reported, never left to silent absence. Reported on
    // the last page of a walk, which is where a real app would flush them.
    deletedIds: hasMore ? [] : bucket(tombstones, shop, url.pathname),
    pagination: {
      limit,
      count: page.length,
      hasMore,
      nextCursor: hasMore && last ? encodeCursor(last) : null,
    },
  });
}

const rateLimitOnce = new Map<string, number>();
const failNext = new Map<string, { count: number; after: number }>();

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const rawBody = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);

    // --- test-harness endpoints, unauthenticated, never part of the contract
    if (url.pathname === "/__mint") {
      const shop = url.searchParams.get("shop") ?? "";
      const token = mintClaimToken({
        shop,
        email: url.searchParams.get("email") ?? `owner@${shop}`,
        isStoreOwner: url.searchParams.get("owner") !== "false",
        jti: url.searchParams.get("jti") ?? undefined,
        expiresInSeconds: url.searchParams.has("expiresIn")
          ? Number(url.searchParams.get("expiresIn"))
          : undefined,
        audience: url.searchParams.get("aud") ?? undefined,
        secret: url.searchParams.get("secret") ?? undefined,
      });
      return json(res, 200, { token });
    }

    if (url.pathname === "/__install") {
      INSTALLED.add((url.searchParams.get("shop") ?? "").toLowerCase());
      return json(res, 200, { installed: [...INSTALLED] });
    }

    if (url.pathname === "/__seed" && req.method === "POST") {
      // { shop, path, rows: [...], deletedIds?: [...] } — rows replace any
      // existing row with the same id, which is how "the app corrected a row"
      // is expressed.
      const seed = JSON.parse(rawBody || "{}") as {
        shop: string;
        path: string;
        rows?: Row[];
        deletedIds?: string[];
        reset?: boolean;
      };
      const shop = seed.shop.toLowerCase();
      const list = bucket(rows, shop, seed.path);

      if (seed.reset) list.length = 0;

      for (const row of seed.rows ?? []) {
        const index = list.findIndex((existing) => existing.id === row.id);
        if (index >= 0) list[index] = row;
        else list.push(row);
      }

      const graves = bucket(tombstones, shop, seed.path);
      for (const id of seed.deletedIds ?? []) {
        if (!graves.includes(id)) graves.push(id);
      }

      return json(res, 200, { rows: list.length, deletedIds: graves.length });
    }

    if (url.pathname === "/__fail") {
      // `after` lets the failure land mid-walk: succeed this many calls, then
      // fail `count` times. Failing from the first call only ever tests a run
      // that never started.
      failNext.set((url.searchParams.get("shop") ?? "").toLowerCase(), {
        count: Number(url.searchParams.get("count") ?? 4),
        after: Number(url.searchParams.get("after") ?? 0),
      });
      return json(res, 200, { ok: true });
    }

    if (url.pathname === "/__rate-limit") {
      // Make the next list call answer 429 with this Retry-After, once.
      rateLimitOnce.set(
        (url.searchParams.get("shop") ?? "").toLowerCase(),
        Number(url.searchParams.get("seconds") ?? 1),
      );
      return json(res, 200, { ok: true });
    }

    if (url.pathname === "/__uninstall") {
      INSTALLED.delete((url.searchParams.get("shop") ?? "").toLowerCase());
      return json(res, 200, { installed: [...INSTALLED] });
    }

    // --- the contract surface
    const verified = verifyGrowzarRequest(req, rawBody);
    if (!verified.ok) {
      return error(res, verified.status, verified.type, verified.message);
    }

    if (LIST_PATHS.has(url.pathname)) {
      return listEndpoint(res, url, req);
    }

    if (url.pathname === "/api/v1/growzar/status") {
      // §11. The shop comes from the header, which is the tenant for the
      // request; the query parameter is a convenience and must agree.
      const headerShop = String(req.headers["x-growzar-shop"] ?? "").toLowerCase();
      const queryShop = (url.searchParams.get("shop") ?? "").toLowerCase();

      if (queryShop && headerShop && queryShop !== headerShop) {
        return error(
          res,
          400,
          "bad_request",
          "X-Growzar-Shop and the shop parameter disagree.",
        );
      }

      const shop = headerShop || queryShop;
      const installed = INSTALLED.has(shop);

      return json(res, 200, {
        installed,
        appVersion: `${APP}-mock-1.0.0`,
        shop,
        capabilities: installed
          ? APP === "courierify"
            ? ["orders:read", "shipments:read", "settlements:read"]
            : ["orders:read", "costs:read"]
          : [],
        planRelevantFeatures: [],
      });
    }

    return error(res, 404, "not_found", "No such endpoint on this mock.");
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(
    `[mock:${APP}] listening on http://127.0.0.1:${PORT} — installed on: ${
      [...INSTALLED].join(", ") || "(none)"
    }`,
  );
});
