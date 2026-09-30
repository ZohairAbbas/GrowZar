#!/bin/bash
# Client-side navigation acceptance: does each section's *data request* return
# that section — the way a browser navigates, not the way curl loads a page?
#
#   mocks/acceptance-client-navigation.sh <built-checkout-dir> [port]
#
# Found necessary on 2026-09-30: every section showed Home's data after a
# click, because loaders read `/finance.data` as the section name. Full page
# loads were fine, so every curl check passed. This requests
# `/<section>.data?_routes=section-<section>` — only the section loader, whose
# blurb is unique to it (the shell's nav lists every section's name, so
# grepping the whole payload for "Finance" would pass even when broken).
#
# Runs the given build privately on loopback against SHADOW_DATABASE_URL with
# a throwaway account; never against the live database or port.
set -u
WT=${1:?built checkout dir}; PORT=${2:-3071}
cd /root/growzar; set -a; . ./.env >/dev/null 2>&1; set +a
# Overrides go AFTER sourcing .env, which sets PORT to the live port.
PORT=${2:-3071}; B=http://127.0.0.1:$PORT
[ "$PORT" != 3020 ] || { echo "refusing to use the live port"; exit 1; }
ss -ltn | grep -q ":$PORT " && { echo "port $PORT is in use"; exit 1; }
export DATABASE_URL="$SHADOW_DATABASE_URL" DATABASE_POOL=1 PORT HOST=127.0.0.1 \
  BETTER_AUTH_URL=$B RESEND_API_KEY= NODE_ENV=production
T=$(mktemp -d)
(cd "$WT" && exec node server.js) > "$T/server.log" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null; wait $PID 2>/dev/null; rm -rf "$T"' EXIT
for _ in $(seq 1 60); do curl -s -o /dev/null "$B/health" && break; sleep 0.5; done

H=(-H "Origin: $B" -H "User-Agent: Mozilla/5.0" -H "Content-Type: application/x-www-form-urlencoded")
J="$T/jar"; E="navcheck-$RANDOM$RANDOM@example.com"
curl -s -o /dev/null -c "$J" -b "$J" "${H[@]}" -X POST "$B/auth/sign-up" \
  --data "name=Nav+Check&email=$E&password=navcheck-pass-123456&next=%2F"
curl -s -o /dev/null -c "$J" -b "$J" "${H[@]}" -X POST "$B/organizations/new" \
  --data "name=Nav+Check&slug=navcheck-$RANDOM$RANDOM&baseCurrency=PKR"

declare -A BLURB=(
  [home]="Your stores, and what changed"
  [orders]="Every order across your stores"
  [shipping]="Parcels, couriers and what each delivery"
  [finance]="Money in, money out"
  [customers]="Who buys from you"
)
failures=0
for sec in home orders shipping finance customers; do
  body=$(curl -s -c "$J" -b "$J" -H "User-Agent: Mozilla/5.0" "$B/$sec.data?_routes=section-$sec")
  got=none
  for s in "${!BLURB[@]}"; do grep -qF "${BLURB[$s]}" <<<"$body" && got=$s; done
  if [ "$got" = "$sec" ]; then echo "   PASS  navigating to /$sec returns $sec"
  else echo "   FAIL  navigating to /$sec returns $got"; failures=$((failures+1)); fi
done
exit $failures
