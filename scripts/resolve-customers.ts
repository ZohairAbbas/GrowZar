/**
 * Re-run customer resolution (rule #19) over rows Growzar already holds.
 *
 *   npx tsx --env-file=.env scripts/resolve-customers.ts <shop-domain>
 *
 * Resolution runs only when a row is *written*, so a change to how identity
 * is read — like learning Financify's `buyer.phone { e164, raw }` shape — does
 * nothing for rows already cached until the app happens to change them. This
 * walks the live ORDER and PARCEL rows and resolves each again. Idempotent:
 * resolving a buyer twice finds the same customer.
 */
import { prisma } from "../app/lib/db.server";
import { buyerFromOrderPayload, resolveCustomer } from "../app/lib/customers/resolve.server";

const BATCH = 500;

async function main() {
  const shopDomain = process.argv[2]?.trim().toLowerCase();
  if (!shopDomain) {
    console.error("Usage: resolve-customers.ts <shop-domain>");
    process.exit(1);
  }

  const store = await prisma.store.findUnique({
    where: { shopDomain },
    select: { id: true, country: true },
  });
  if (!store) throw new Error(`No store ${shopDomain}`);

  const before = await prisma.customer.count({ where: { storeId: store.id } });
  let rows = 0, created = 0, noIdentity = 0, phoneProblems = 0;
  let cursor: string | undefined;

  for (;;) {
    const page = await prisma.rawRecord.findMany({
      where: { storeId: store.id, entity: { in: ["ORDER", "PARCEL"] }, deletedAt: null },
      select: { id: true, payload: true, sourceUpdatedAt: true },
      orderBy: { id: "asc" },
      take: BATCH,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (!page.length) break;

    for (const row of page) {
      rows += 1;
      const resolved = await resolveCustomer({
        storeId: store.id,
        buyer: buyerFromOrderPayload(row.payload),
        defaultRegion: store.country,
        seenAt: row.sourceUpdatedAt,
      });
      if (!resolved) noIdentity += 1;
      else if (resolved.created) created += 1;
      if (resolved?.phoneProblem) phoneProblems += 1;
    }

    cursor = page[page.length - 1]!.id;
    console.log(`  ${rows} rows…`);
  }

  const after = await prisma.customer.count({ where: { storeId: store.id } });
  console.log(
    `${shopDomain}: ${rows} rows, customers ${before} → ${after} (+${created}), ` +
      `${noIdentity} without a usable identity, ${phoneProblems} unparseable phone(s)`,
  );
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
