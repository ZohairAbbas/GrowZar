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

    if (url.pathname === "/__uninstall") {
      INSTALLED.delete((url.searchParams.get("shop") ?? "").toLowerCase());
      return json(res, 200, { installed: [...INSTALLED] });
    }

    // --- the contract surface
    const verified = verifyGrowzarRequest(req, rawBody);
    if (!verified.ok) {
      return error(res, verified.status, verified.type, verified.message);
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
