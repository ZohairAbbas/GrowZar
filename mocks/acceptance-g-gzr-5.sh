#!/usr/bin/env bash
# G-GZR-5: the event relay.
#
# Needs both mock apps and the dev server running, with the environment that
# points Growzar at the mocks (see mocks/README.md). Events are emitted through
# the mock's /__emit so they are signed exactly as a real app would sign them.
#
#   set -a; . your.env; set +a
#   NODE_PATH=$PWD/node_modules bash mocks/acceptance-g-gzr-5.sh
set -u

B=${GROWZAR_URL:-http://127.0.0.1:3020}
CFY=${CFY:-http://127.0.0.1:4010}
D=$(date +%s)
SHOP="events-$D.myshopify.com"; export SHOP
SCRATCH=$(mktemp -d); export SCRATCH; trap 'rm -rf "$SCRATCH"' EXIT

fails=0
check () { # label, expected, actual
  if [ "$2" = "$3" ]; then printf '   PASS  %s\n' "$1"
  else printf '   FAIL  %s — expected %s, got %s\n' "$1" "$2" "$3"; fails=$((fails+1)); fi
}

emit () { # json, [extra query]
  curl -s -X POST "$CFY/__emit?growzar=$B${2:+&$2}" -H 'content-type: application/json' -d "$1"
}
statusOf () { emit "$1" "${2:-}" | sed 's/.*"status":\([0-9]*\).*/\1/'; }

# A claimed store for the events to land on.
node -e '
const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const p = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
(async () => {
  const org = await p.organization.create({ data: { name: "Events '$D'", slug: "events-'$D'", baseCurrency: "PKR" } });
  const store = await p.store.create({ data: { organizationId: org.id, shopDomain: "'$SHOP'" } });
  await p.appConnection.create({ data: { storeId: store.id, app: "COURIERIFY", status: "CONNECTED", connectedAt: new Date() } });
  require("fs").writeFileSync(process.env.SCRATCH + "/store.txt", store.id);
  await p.$disconnect();
})();
' 2>/dev/null


echo "1. an unsigned event is rejected, even though it came from this box"
check "no signature -> 401" 401 "$(statusOf '{"eventId":"u-'$D'","topic":"shipment.delivered","occurredAt":"2026-09-24T06:00:00Z","shop":"'$SHOP'","data":{"shipmentId":"SHP-1"}}' 'sign=none')"

echo "2. a signature from the wrong secret is rejected"
check "bad signature -> 401" 401 "$(statusOf '{"eventId":"b-'$D'","topic":"shipment.delivered","occurredAt":"2026-09-24T06:00:00Z","shop":"'$SHOP'","data":{"shipmentId":"SHP-1"}}' 'sign=bad')"

echo "3. a signature outside the 5-minute window is rejected"
OLD=$(( ($(date +%s) - 600) * 1000 ))
check "stale timestamp -> 401" 401 "$(statusOf '{"eventId":"s-'$D'","topic":"shipment.delivered","occurredAt":"2026-09-24T06:00:00Z","shop":"'$SHOP'","data":{"shipmentId":"SHP-1"}}' "ts=$OLD")"

echo "4. a properly signed event is accepted quickly"
EV='{"eventId":"ok-'$D'","topic":"shipment.delivered","occurredAt":"2026-09-24T06:00:00Z","shop":"'$SHOP'","actor":{"type":"courier","id":"postex"},"data":{"shipmentId":"SHP-1"}}'
check "signed -> 202" 202 "$(statusOf "$EV")"

echo "5. the same event again is recognised as a replay, not applied twice"
check "replay -> 202" 202 "$(statusOf "$EV")"

echo "6. app.uninstalled puts the section into reconnect mode (D-17)"
UN='{"eventId":"un-'$D'","topic":"app.uninstalled","occurredAt":"2026-09-24T07:00:00Z","shop":"'$SHOP'","data":{}}'
check "uninstall -> 202" 202 "$(statusOf "$UN")"

echo "   (processing the queued events)"
NODE_PATH=${NODE_PATH:-$PWD/node_modules} npx tsx --conditions=development "$(dirname "$0")/acceptance-g-gzr-5.mts"
