import { createRequestHandler } from "@react-router/express";
import compression from "compression";
import express from "express";

/**
 * Growzar's HTTP server.
 *
 * `react-router-serve` would do for a server facing the internet directly, but
 * Growzar sits behind nginx, which terminates TLS. `react-router-serve` builds
 * its Express app without `trust proxy` and offers no way to set it, so the
 * server sees `http://` while the browser sends `Origin: https://…`. React
 * Router compares the two and aborts every action as a possible CSRF attack.
 *
 * The effect is invisible to curl — which sends no `Origin` header — and total
 * in a browser: sign-in, sign-up and every other form answer 400. That is how
 * this got as far as production. Any future check of a form has to send an
 * `Origin` header or it is not testing what a merchant does.
 *
 * `loopback` rather than `true`: nginx connects from 127.0.0.1, and trusting
 * `X-Forwarded-*` from anywhere else would let a client that reached this port
 * directly claim any scheme or address it liked.
 */
const app = express();

app.set("trust proxy", "loopback");

// nginx does not compress proxied responses by default, so it happens here.
app.use(compression());

// The app is behind nginx; advertising the stack to the internet gains nothing.
app.disable("x-powered-by");

// Fingerprinted assets can be cached hard; everything else in build/client is
// served normally.
app.use(
  "/assets",
  express.static("build/client/assets", {
    immutable: true,
    maxAge: "1y",
  }),
);
app.use(express.static("build/client", { maxAge: "1h" }));

app.all(
  "*splat",
  createRequestHandler({
    build: () => import("./build/server/index.js"),
  }),
);

const port = Number(process.env.PORT ?? 3020);
const host = process.env.HOST ?? "127.0.0.1";

app.listen(port, host, () => {
  console.log(`[web] Growzar listening on http://${host}:${port}`);
});
