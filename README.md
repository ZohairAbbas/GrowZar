# Growzar

One front door for the six-app suite. Standalone web product, free, outside Shopify (D-01, D-06).
Merchants open it from inside an app they already have installed; their other installed apps connect
automatically.

**Read first:** `/root/growzar-kb/synthesis/DECISIONS.md` (what Growzar is),
`/root/growzar-kb/synthesis/CONFLICTING-DATA-POINTS.md` (32 display rules — which app is the source
for each number), `/root/growzar-kb/contracts/API-CONTRACT.md` (how Growzar talks to the apps), and
`/root/growzar-kb/synthesis/PLAN.md` (phases and dates).

## Stack

| Piece | Choice | Why |
|---|---|---|
| Framework | React Router 8 (SSR) | Same model as the Remix apps the team maintains daily; every screen is per-merchant data behind a session |
| Database | PostgreSQL 16, `growzar` database, `growzar_app` role | Own database on the shared instance; the role cannot reach the app databases |
| ORM | Prisma 7 with the `pg` driver adapter | Prisma 7 moved the URL to `prisma.config.ts` (migrations) and the adapter (runtime) |
| Auth | Better Auth 1.7.5 + organization plugin | D-28: self-hosted, organizations/members/invitations built in, no per-user fees |
| Styling | Tailwind 3.4 | Matches the salvaged old-hub components in `/root/growzar-kb/salvage` |
| Queues | BullMQ on the box's existing Redis, prefix `growzar` | Connector sync and the event relay |
| Runtime | **Node 24 via nvm** (`/root/.nvm/versions/node/v24.21.0`) | React Router 8 and Prisma 7 need Node 22+. The system Node 20 stays untouched for the four apps |

## Running it here

This box also runs Courierify, Preventify, Retainify and Inventorify in production, on 2 vCPUs with
swap already full. Growzar stays inside its limits: a 4-connection web pool, a 2-connection worker
pool, `MemoryMax=1G` on the web unit and 768M on the worker.

```bash
cd /root/growzar
nvm use            # reads .nvmrc -> Node 24; without this you get the system Node 20
npm run dev        # http://127.0.0.1:3020
npm run typecheck
npm run build && npm start
```

`nvm alias default` is deliberately set to `system`, so a plain shell still gets Node 20 and an
accidental `npm run build` in an app's directory can't produce a Node 24 build.

## Deployment

systemd, not PM2 — PM2 has served stale secrets on these hosts twice, because it keeps each
process's environment in its saved dump. Units are in `docs/deploy/`; secrets live in
`/etc/growzar/growzar.env` (root, mode 600).

```bash
cp docs/deploy/growzar.service docs/deploy/growzar-worker.service /etc/systemd/system/
mkdir -p /var/log/growzar /etc/growzar
systemctl daemon-reload && systemctl enable --now growzar growzar-worker
```

## Rules that shape the code

1. **The owning app does the work.** Growzar renders and coordinates; an action calls the app that
   owns it (D-22). No writes into app databases, ever, and no direct reads either (D-14).
2. **Growzar computes anything cross-app itself** — customer identity, the funnel, per-product
   return rates. It never shows one app's count of something another app also counts.
3. **Shop-local days everywhere** (rule #5), money always with its currency (rule #4), Shopify
   numeric order ID and variant ID as the only join keys (rules #6, #30).
4. **Test stores only until the pilot.** No production buyer data while Q11 and U6 are open.
