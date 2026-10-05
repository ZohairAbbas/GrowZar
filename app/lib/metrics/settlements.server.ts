import { prisma } from "../db.server";
import { payerHistories, readPayout, type PayerHistory } from "./settlements";

/** Each payer's payout history on one store, from Courierify's settlement feed. */
export async function loadPayerHistories(storeId: string): Promise<PayerHistory[]> {
  const rows = await prisma.rawRecord.findMany({
    where: { storeId, app: "COURIERIFY", entity: "SETTLEMENT", deletedAt: null },
    select: { payload: true },
  });
  return payerHistories(rows.map((r) => readPayout((r.payload ?? {}) as Record<string, unknown>)).filter((p) => p !== null));
}
