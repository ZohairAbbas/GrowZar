/**
 * Attach a shop to the internal `pilot` organization without a claim token,
 * then auto-connect every app that says it is installed (D-03).
 *
 *   npx tsx --env-file=.env scripts/attach-pilot-store.ts <shop-domain>
 *
 * For pilot stores only, by decision (D-48, and the human's choice on
 * 2026-09-29 to attach `0dscam-qn` by hand while "Open in Growzar" is hidden
 * in Courierify). The ordinary path is the owner's claim token (§10); this
 * one skips the proof of ownership, so:
 *
 *  - the store belongs to the `pilot` organization. A later claim by the real
 *    owner arrives as an access request the pilot organization answers, not
 *    as a silent move;
 *  - `claimedByUserId` stays null, which is how a hand-attached store is told
 *    apart from a claimed one.
 *
 * Then run `npm run enroll <shop-domain> --backfill-days 90`.
 */
import { prisma } from "../app/lib/db.server";
import { autoConnectApps } from "../app/lib/claim.server";

async function main() {
  const shopDomain = process.argv[2]?.trim().toLowerCase();
  if (!shopDomain?.endsWith(".myshopify.com")) {
    console.error("Usage: attach-pilot-store.ts <shop>.myshopify.com");
    process.exit(1);
  }

  const pilot = await prisma.organization.findUnique({ where: { slug: "pilot" } });
  if (!pilot) throw new Error("No `pilot` organization");

  const existing = await prisma.store.findUnique({ where: { shopDomain } });
  if (existing && existing.organizationId !== pilot.id) {
    // Never move a store between organizations from a script.
    throw new Error(`${shopDomain} already belongs to another organization`);
  }

  const store =
    existing ??
    (await prisma.store.create({
      data: { organizationId: pilot.id, shopDomain },
    }));
  console.log(`${existing ? "Already attached" : "Attached"}: ${shopDomain} → pilot (${store.id})`);

  const results = await autoConnectApps({ storeId: store.id, shopDomain });
  for (const r of results) {
    console.log(`  ${r.app.padEnd(12)} ${r.installed === true ? "CONNECTED" : r.installed === false ? "not installed" : `unknown (${r.reason})`}`);
  }

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
