#!/usr/bin/env bash
# G-GZR-4: connector framework and sync.
#
# Needs both mock apps running (see mocks/README.md) and the environment that
# points Growzar at them. Runs the sync engine directly rather than through the
# worker, so each step's effect is observable.
#
#   set -a; . your.env; set +a
#   NODE_PATH=$PWD/node_modules bash mocks/acceptance-g-gzr-4.sh
set -u

CFY=http://127.0.0.1:4010
FIN=http://127.0.0.1:4011
D=$(date +%s)
SHOP="sync-$D.myshopify.com"

seed () { curl -s -o /dev/null -X POST "$1/__seed" -H 'content-type: application/json' -d "$2"; }

# 450 orders across 3 pages at the contract's 200-row limit, plus parcels,
# settlement lines and costs.
node -e '
const shop = "'$SHOP'";
const iso = (i) => new Date(Date.UTC(2026, 8, 1, 0, 0, i)).toISOString();
const post = async (base, path, rows) => {
  const res = await fetch(base + "/__seed", { method: "POST", headers: {"content-type":"application/json"}, body: JSON.stringify({ shop, path, rows, reset: true }) });
  if (!res.ok) throw new Error(path + ": " + res.status);
};
const orders = Array.from({ length: 450 }, (_, i) => ({
  id: String(5123456789000 + i), orderId: String(5123456789000 + i),
  updatedAt: iso(i), orderName: "#" + (1000 + i),
  total: { amount: "4500.00", currency: "PKR" },
  courierFee: { amount: "250.00", currency: "PKR" },
  confirmationStatus: i % 3 === 0 ? "unconfirmed" : "confirmed",
}));
const parcels = Array.from({ length: 120 }, (_, i) => ({
  id: "SHP-" + i, shipmentId: "SHP-" + i, updatedAt: iso(i),
  orderId: String(5123456789000 + i), courier: i % 2 ? "postex" : "leopards",
  city: i % 2 ? "Karachi" : "Lahore", status: "delivered",
  bookedFee: { amount: "250.00", currency: "PKR" },
}));
const settlements = Array.from({ length: 60 }, (_, i) => ({
  id: "STL-" + i, settlementLineId: "STL-" + i, updatedAt: iso(i),
  shipmentId: "SHP-" + i, amount: { amount: "4250.00", currency: "PKR" },
  settledAt: iso(i),
}));
const costs = Array.from({ length: 40 }, (_, i) => ({
  id: "CST-" + i, costId: "CST-" + i, updatedAt: iso(i),
  variantId: "4412" + i, unitCost: { amount: "1200.00", currency: "PKR" },
}));
(async () => {
  await post("'$CFY'", "/api/v1/growzar/shipments", parcels);
  await post("'$CFY'", "/api/v1/growzar/settlements", settlements);
  await post("'$FIN'", "/api/v1/orders", orders);
  await post("'$FIN'", "/api/v1/costs", costs);
})();
'
curl -s -o /dev/null "$CFY/__install?shop=$SHOP"
curl -s -o /dev/null "$FIN/__install?shop=$SHOP"

export SHOP CFY FIN
npx tsx --conditions=development "$(dirname "$0")/acceptance-g-gzr-4.mts"
