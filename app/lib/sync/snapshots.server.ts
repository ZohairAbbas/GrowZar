import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";

import { prisma } from "../db.server";

/**
 * Versioned, finalizing snapshots at order grain, for COD money that settles
 * late (G-GZR-4).
 *
 * An order's money is not knowable on the day it is placed. The courier
 * settles days or weeks later, a return arrives after that, and a fee is
 * sometimes corrected later still. So an order's financial picture is stored
 * as a sequence of versions, each true when it was written, with the last one
 * marked final once nothing can change again.
 *
 * The old hub built this at daily grain and got three things wrong. Each is
 * prevented here by construction, not by remembering:
 *
 *  1. Finalization collided on the second run.
 *  2. Change detection ignored costs, so late corrections never produced a new
 *     version — the exact case the whole mechanism exists for.
 *  3. Consumers summed every version and double-counted.
 */

/**
 * Canonical JSON: object keys sorted, recursively. Two payloads that differ
 * only in key order must hash the same, or every sync would write a new
 * version for no reason.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    // `undefined` is not JSON and would otherwise hash differently from an
    // absent key, which is the same thing as far as an app's payload goes.
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries
    .map(([key, v]) => `${JSON.stringify(key)}:${canonicalize(v)}`)
    .join(",")}}`;
}

/**
 * The hash is over the WHOLE payload.
 *
 * Defect 2 was a change detector that compared a hand-written list of fields,
 * and costs were not on the list — so a settlement correction that changed
 * only the fee produced no new version and the corrected money was never seen.
 * Naming no fields is what makes forgetting one impossible.
 */
export function contentHashOf(payload: unknown): string {
  return createHash("sha256").update(canonicalize(payload)).digest("hex");
}

export type SnapshotOutcome =
  | { kind: "unchanged"; version: number }
  | { kind: "written"; version: number; isFinal: boolean }
  | { kind: "already_final"; version: number };

/**
 * Record what is known about an order now.
 *
 * Writes a new version only when the content actually changed. Returns what
 * happened, because "nothing changed" is a real and common answer that the
 * caller may want to count.
 */
export async function recordOrderSnapshot(options: {
  storeId: string;
  orderId: string;
  payload: Prisma.InputJsonValue;
  /** True when this is the last word on the order's money. */
  isFinal?: boolean;
}): Promise<SnapshotOutcome> {
  const { storeId, orderId, payload } = options;
  const isFinal = options.isFinal ?? false;
  const hash = contentHashOf(payload);

  // Retried on a unique-constraint collision rather than crashing. Two workers
  // — or one worker run twice, which is what defect 1 actually was — can reach
  // the same order at the same instant and compute the same next version. The
  // constraint catches it; re-reading and trying again resolves it.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const latest = await prisma.orderSnapshot.findFirst({
      where: { storeId, orderId },
      orderBy: { version: "desc" },
    });

    // Defect 1, the other half: finalizing an order that is already final is a
    // no-op, not a second final row. A sync that re-reads a settled order —
    // which the five-minute cycle does constantly — must not keep writing.
    if (latest?.isFinal) {
      return { kind: "already_final", version: latest.version };
    }

    if (latest && latest.contentHash === hash && latest.isFinal === isFinal) {
      return { kind: "unchanged", version: latest.version };
    }

    const version = (latest?.version ?? 0) + 1;

    try {
      await prisma.$transaction(async (tx) => {
        await tx.orderSnapshot.create({
          data: { storeId, orderId, version, isFinal, contentHash: hash, payload },
        });

        // Defect 3's belt to the view's braces: every older version is stamped
        // superseded in the same transaction, so a consumer filtering on
        // `supersededAt IS NULL` is correct even if it never heard of the view.
        if (latest) {
          await tx.orderSnapshot.updateMany({
            where: { storeId, orderId, supersededAt: null, version: { lt: version } },
            data: { supersededAt: new Date() },
          });
        }
      });

      return { kind: "written", version, isFinal };
    } catch (error) {
      const collided =
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "P2002";

      if (!collided) throw error;
      // Someone else took this version number. Read again and recompute.
    }
  }

  throw new Error(
    `Could not allocate a snapshot version for order ${orderId} after 3 attempts`,
  );
}

export type LatestOrderSnapshot = {
  id: string;
  storeId: string;
  orderId: string;
  version: number;
  isFinal: boolean;
  contentHash: string;
  payload: unknown;
  createdAt: Date;
};

/**
 * The only supported way to read snapshots.
 *
 * Defect 3 was consumers reading `order_snapshots` directly and summing every
 * version, double-counting every order that had ever been revised. This reads
 * the `latest_order_snapshots` view, which returns exactly one row per order.
 * Phase 2's metric layer builds on this function, not on the table.
 */
export async function latestOrderSnapshots(
  storeId: string,
  options: { orderIds?: string[]; limit?: number } = {},
): Promise<LatestOrderSnapshot[]> {
  const { orderIds, limit } = options;

  if (orderIds && orderIds.length === 0) return [];

  return prisma.$queryRaw<LatestOrderSnapshot[]>`
    SELECT id, "storeId", "orderId", version, "isFinal", "contentHash", payload, "createdAt"
    FROM latest_order_snapshots
    WHERE "storeId" = ${storeId}
      ${orderIds ? Prisma.sql`AND "orderId" = ANY(${orderIds})` : Prisma.empty}
    ORDER BY "orderId"
    ${limit ? Prisma.sql`LIMIT ${limit}` : Prisma.empty}
  `;
}
