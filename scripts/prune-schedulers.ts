/**
 * Remove sync schedules whose store no longer exists.
 *
 * A BullMQ job scheduler lives in Redis, independently of the database.
 * Deleting a store does not touch it, so its cycle keeps firing every five
 * minutes, forever, doing nothing — on a box with 2 vCPUs and no headroom.
 *
 * The worker now removes its own schedule when it finds the store gone, so
 * this is a broom for schedules left by earlier runs rather than something
 * that should be needed routinely. It is safe to run at any time.
 *
 *   npx tsx scripts/prune-schedulers.ts [--dry-run]
 */
import { Queue } from "bullmq";
import IORedis from "ioredis";

import { prisma } from "../app/lib/db.server";

const dryRun = process.argv.includes("--dry-run");

async function main() {
  const connection = new IORedis(
    process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
    { maxRetriesPerRequest: null },
  );

  const queue = new Queue("sync", {
    connection,
    prefix: process.env.BULLMQ_PREFIX ?? "growzar",
  });

  // Through BullMQ's own API rather than a raw Redis DEL: a scheduler owns
  // several keys, and removing one by hand leaves the rest behind.
  const schedulers = await queue.getJobSchedulers(0, 1000);

  let removed = 0;
  let kept = 0;

  for (const scheduler of schedulers) {
    const key = String(scheduler.key ?? "");
    const storeId = key.replace(/^cycle:/, "");

    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: { shopDomain: true },
    });

    if (store) {
      kept += 1;
      console.log(`  keep    ${store.shopDomain}`);
      continue;
    }

    if (dryRun) {
      console.log(`  WOULD REMOVE  ${key} (no such store)`);
    } else {
      await queue.removeJobScheduler(key);
      console.log(`  removed ${key} (no such store)`);
    }
    removed += 1;
  }

  console.log(
    `\n${schedulers.length} schedule(s): ${kept} kept, ${removed} ${dryRun ? "would be removed" : "removed"}`,
  );

  await queue.close();
  await connection.quit();
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
