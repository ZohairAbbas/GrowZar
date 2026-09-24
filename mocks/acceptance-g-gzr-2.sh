#!/usr/bin/env bash
# G-GZR-2: roles and store scope — run it against a dev server started with the mock apps configured
# (see mocks/README.md). The invitation and claim links are read from the dev
# server's log, because with no RESEND_API_KEY the mailer logs them instead of
# sending; point DEV_LOG at that log.
#
#   DEV_LOG=/path/to/dev.log bash mocks/acceptance-g-gzr-2.sh
set -u
DEV_LOG=${DEV_LOG:?set DEV_LOG to the dev server log file}
SCRATCH=$(mktemp -d)
export SCRATCH
trap 'rm -rf "$SCRATCH"' EXIT
cd "$SCRATCH"

B=http://127.0.0.1:3020
D=$(date +%s)
rm -f own.txt stf.txt
OWNER="owner-$D@test-growzar.pk"; STAFF="packer-$D@test-growzar.pk"

curl -s -o /dev/null -c own.txt -X POST $B/auth/sign-up -d "name=Owner $D" -d "email=$OWNER" -d "password=correcthorsebattery" -d "next=/"
curl -s -o /dev/null -b own.txt -c own.txt -X POST $B/organizations/new -d "name=Scope Test $D" -d "slug=scope-test-$D" -d "baseCurrency=PKR"

node -e '
const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const p = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
(async () => {
  const org = await p.organization.findFirst({ where: { slug: "scope-test-'$D'" } });
  for (const [d, n] of [["alpha-'$D'.myshopify.com","Alpha"],["beta-'$D'.myshopify.com","Beta"]])
    await p.store.create({ data: { organizationId: org.id, shopDomain: d, displayName: n, currency: "PKR", timezone: "Asia/Karachi" } });
  const s = await p.store.findMany({ where: { organizationId: org.id }, orderBy: { shopDomain: "asc" }, select: { id: true } });
  require("fs").writeFileSync(process.env.SCRATCH + "/ids.txt", s.map(x=>x.id).join("\n"));
  await p.$disconnect();
})();
' 2>/dev/null
ALPHA=$(sed -n 1p "$SCRATCH/ids.txt"); BETA=$(sed -n 2p "$SCRATCH/ids.txt")

echo "1. owner sees both stores"
curl -s -b own.txt $B/stores | grep -oE "alpha-$D.myshopify.com|beta-$D.myshopify.com" | sort -u | sed 's/^/     /'

curl -s -o /dev/null -b own.txt -c own.txt -X POST $B/settings/team -d "intent=invite" -d "email=$STAFF" -d "role=staff"
INV=$(grep -oE 'http://127.0.0.1:3020/invitations/[A-Za-z0-9]+' "$DEV_LOG" | tail -1)
curl -s -o /dev/null -c stf.txt -X POST $B/auth/sign-up -d "name=Packer $D" -d "email=$STAFF" -d "password=correcthorsebattery" -d "next=/"
curl -s -o /dev/null -b stf.txt -c stf.txt -X POST "$INV" -d "intent=accept"

node -e '
const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const p = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
(async () => {
  const u = await p.user.findFirst({ where: { email: "'$STAFF'" } });
  const m = await p.member.findFirst({ where: { userId: u.id } });
  require("fs").writeFileSync(process.env.SCRATCH + "/mid.txt", m.id);
  await p.$disconnect();
})();
' 2>/dev/null
MID=$(cat "$SCRATCH/mid.txt")

echo "2. owner scopes that staff member to Alpha only, through the UI"
curl -s -o /dev/null -b own.txt -c own.txt -X POST $B/settings/team/$MID -d "role=staff" -d "scopeAllStores=subset" -d "storeIds=$ALPHA"

echo "3. staff store list"
curl -s -b stf.txt $B/stores | grep -oE "alpha-$D.myshopify.com|beta-$D.myshopify.com" | sort -u | sed 's/^/     /'

echo "4. staff opens Alpha by direct URL   -> $(curl -s -o /dev/null -w '%{http_code}' -b stf.txt $B/stores/$ALPHA)"
echo "5. staff opens Beta by direct URL    -> $(curl -s -o /dev/null -w '%{http_code}' -b stf.txt $B/stores/$BETA)"
echo "6. staff opens Finance-only settings -> $(curl -s -o /dev/null -w '%{http_code}' -b stf.txt $B/settings/roles)"
echo "7. staff posts the invite form       -> $(curl -s -o /dev/null -w '%{http_code}' -b stf.txt -X POST $B/settings/team -d 'intent=invite' -d 'email=x@test-growzar.pk' -d 'role=admin')"
echo "8. owner opens Beta                  -> $(curl -s -o /dev/null -w '%{http_code}' -b own.txt $B/stores/$BETA)"
echo "9. the 403 body staff gets on Beta:"
curl -s -b stf.txt $B/stores/$BETA | grep -oE '<h1[^>]*>[^<]*|not available to you' | sed 's/.*>//' | sed 's/^/     /'
