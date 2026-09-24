# Mock app servers

A contract-conformant stand-in for a suite app, so Growzar's claim, sync and
event work can be verified before the real apps expose their Growzar-facing
endpoints.

Courierify's platform credential, signature verification and
`/api/v1/growzar/status` are G-CFY-2, landing in parallel with Phase 1 day 3.
Financify has no base URL on this box at all. Without this, days 3–5 would
have nothing to run against.

## What it is, and is not

It implements the **rules** in `contracts/API-CONTRACT.md`, not a convenient
subset — signature verification, the shop-header/parameter agreement, closed
CORS, contract-shaped errors. Where it refuses something, the real app is
meant to refuse it too. If Growzar passes against this and fails against
Courierify, that difference is a finding about Courierify, and belongs in the
Phase 1 report.

It is **not** a fake app: there is no business logic, no data, and no
persistence. Its `__` endpoints exist only to drive tests and have no
counterpart in the contract.

## Running

```sh
MOCK_SECRET=courierify-mock-secret MOCK_KEY=courierify-mock-key npm run mock:courierify
MOCK_SECRET=financify-mock-secret  MOCK_KEY=financify-mock-key  npm run mock:financify
```

Then point Growzar at them in `.env`:

```sh
COURIERIFY_BASE_URL="http://127.0.0.1:4010"
COURIERIFY_PLATFORM_KEY="courierify-mock-key"
COURIERIFY_SIGNING_SECRET="courierify-mock-secret"
FINANCIFY_BASE_URL="http://127.0.0.1:4011"
FINANCIFY_PLATFORM_KEY="financify-mock-key"
FINANCIFY_SIGNING_SECRET="financify-mock-secret"
```

Swapping in the real apps is three lines of `.env` per app and no code change.

| Variable | Meaning |
|---|---|
| `MOCK_APP` | `iss` in claim tokens, and the app's identity (default `courierify`) |
| `MOCK_PORT` | default `4010` |
| `MOCK_SECRET` | the app's Growzar signing secret — HMAC **and** claim tokens |
| `MOCK_KEY` | the platform bearer key Growzar sends |
| `MOCK_INSTALLED` | comma-separated shop domains this app is installed on |

## Contract endpoints

- `GET /api/v1/growzar/status` — §11. Requires a valid bearer key **and**
  signature; rejects a `shop` parameter that disagrees with `X-Growzar-Shop`.

## Test-harness endpoints (not part of the contract)

Unauthenticated, and deliberately obvious with their `__` prefix.

| Endpoint | Purpose |
|---|---|
| `GET /__mint?shop=&email=&owner=` | Mint a claim token (§10) |
| `GET /__mint?...&expiresIn=-60` | An already-expired token |
| `GET /__mint?...&aud=someone-else` | Wrong audience |
| `GET /__mint?...&secret=wrong` | Signed with the wrong secret |
| `GET /__mint?...&jti=fixed` | A fixed `jti`, for replay tests |
| `GET /__install?shop=` | Report the app as installed on a shop |
| `GET /__uninstall?shop=` | Report it as uninstalled |
