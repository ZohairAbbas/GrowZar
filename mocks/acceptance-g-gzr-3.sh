#!/usr/bin/env bash
# G-GZR-3: claiming and auto-connect — run it against a dev server started with the mock apps configured
# (see mocks/README.md). The invitation and claim links are read from the dev
# server's log, because with no RESEND_API_KEY the mailer logs them instead of
# sending; point DEV_LOG at that log.
#
#   DEV_LOG=/path/to/dev.log bash mocks/acceptance-g-gzr-3.sh
set -u
DEV_LOG=${DEV_LOG:?set DEV_LOG to the dev server log file}

B=http://127.0.0.1:3020
CFY=http://127.0.0.1:4010
FIN=http://127.0.0.1:4011
D=$(date +%s)
SHOP="claim-$D.myshopify.com"
rm -f c_own.txt c_two.txt

# Both apps are installed on this shop.
curl -s -o /dev/null "$CFY/__install?shop=$SHOP"
curl -s -o /dev/null "$FIN/__install?shop=$SHOP"

mint () { curl -s "$CFY/__mint?shop=$SHOP&email=$1&owner=$2${3:+&$3}" | sed 's/.*"token":"//; s/".*//'; }

echo "1. owner presses Open in Growzar inside Courierify, signed out"
TOKEN=$(mint "owner-$D@test-growzar.pk" true)
LOC=$(curl -s -o /dev/null -w '%{redirect_url}' -c c_own.txt -X POST $B/claim -d "token=$TOKEN")
PC=${LOC##*/}
echo "   -> pending claim ${PC:0:8}…"
echo "   signed-out page offers: $(curl -s $B/claim/$PC | grep -oE 'Create an account|I already have one' | tr '\n' ' ')"

echo "2. replaying the same token"
echo "   -> $(curl -s -X POST $B/claim -d "token=$TOKEN" | grep -oE 'already been used|not a valid' | head -1)"

echo "3. owner signs up, then connects"
curl -s -o /dev/null -b c_own.txt -c c_own.txt -X POST $B/auth/sign-up -d "name=Owner $D" -d "email=owner-$D@test-growzar.pk" -d "password=correcthorsebattery" -d "next=/claim/$PC"
curl -s -o /dev/null -b c_own.txt -c c_own.txt -X POST $B/organizations/new -d "name=Claim Test $D" -d "slug=claim-test-$D" -d "baseCurrency=PKR"
ORG=$(curl -s -b c_own.txt $B/claim/$PC | grep -oE '<input[^>]*name="organizationId"[^>]*>' | head -1 | grep -oE 'value="[^"]+"' | sed 's/value="//; s/"//')
STORE_LOC=$(curl -s -o /dev/null -w '%{redirect_url}' -b c_own.txt -c c_own.txt -X POST $B/claim/$PC -d "organizationId=$ORG")
STORE=${STORE_LOC##*/}
echo "   -> landed on store ${STORE:0:8}…"

echo "4. auto-connect: which apps got connected without the merchant doing anything"
curl -s -b c_own.txt "$B/stores/$STORE" | grep -oE '>(courierify|financify|whatkabot|preventify|retainify|inventorify)<' | tr -d '><' | sort | sed 's/^/     /'

echo "5. a second, unrelated account claims the same shop"
TOKEN2=$(mint "other-$D@test-growzar.pk" true)
LOC2=$(curl -s -o /dev/null -w '%{redirect_url}' -c c_two.txt -X POST $B/claim -d "token=$TOKEN2")
PC2=${LOC2##*/}
curl -s -o /dev/null -b c_two.txt -c c_two.txt -X POST $B/auth/sign-up -d "name=Other $D" -d "email=other-$D@test-growzar.pk" -d "password=correcthorsebattery" -d "next=/claim/$PC2"
curl -s -o /dev/null -b c_two.txt -c c_two.txt -X POST $B/organizations/new -d "name=Other Org $D" -d "slug=other-org-$D" -d "baseCurrency=PKR"
ORG2=$(curl -s -b c_two.txt $B/claim/$PC2 | grep -oE '<input[^>]*name="organizationId"[^>]*>' | head -1 | grep -oE 'value="[^"]+"' | sed 's/value="//; s/"//')
echo "   warning shown: $(curl -s -b c_two.txt $B/claim/$PC2 | grep -oE 'already connected to another organization' | head -1)"
curl -s -b c_two.txt -c c_two.txt -X POST $B/claim/$PC2 -d "organizationId=$ORG2" | grep -oE 'Waiting for approval|We have asked them' | head -1 | sed 's/^/   -> /'

echo "6. store rows for this shop in the database:"
node -e '
const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const p = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
(async () => {
  const s = await p.store.findMany({ where: { shopDomain: "'$SHOP'" }, select: { id: true, organizationId: true } });
  console.log("     " + s.length + " row(s)");
  const r = await p.storeAccessRequest.findMany({ where: { status: "PENDING" } });
  console.log("     " + r.length + " pending access request(s)");
  await p.$disconnect();
})();
' 2>/dev/null

echo "7. owner sees and approves the request"
curl -s -b c_own.txt $B/stores/$STORE | grep -oE 'Access requests|says they own this shop' | head -2 | sed 's/^/     /'
REQ=$(curl -s -b c_own.txt $B/stores/$STORE | grep -oE 'name="requestId" value="[^"]+"' | head -1 | sed 's/.*value="//; s/"//')
curl -s -b c_own.txt -c c_own.txt -X POST $B/stores/$STORE -d "requestId=$REQ" -d "intent=approve" | grep -oE 'Access granted' | head -1 | sed 's/^/   -> /'
echo "   the second account can now open the store -> $(curl -s -o /dev/null -w "%{http_code}" -L -b c_two.txt -c c_two.txt $B/stores/$STORE)"

echo "8. tokens that must be refused"
for case in "expiresIn=-60:expired" "aud=someone-else:audience" "secret=wrong-secret:signature"; do
  q=${case%%:*}; label=${case##*:}
  T=$(curl -s "$CFY/__mint?shop=$SHOP&email=x@test.pk&owner=true&$q" | sed 's/.*"token":"//; s/".*//')
  printf "   %-10s -> %s\n" "$label" "$(curl -s -X POST $B/claim -d "token=$T" | grep -oE 'has expired|not issued for Growzar|could not be verified|not a valid Growzar link' | head -1)"
done
