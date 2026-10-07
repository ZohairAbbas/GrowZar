import { prisma } from "../db.server";
import { payerHistories, readPayout, readStatement, type PayerHistory, type Statement } from "./settlements";

/** Each payer's payout history on one store, from Courierify's settlement feed. */
export async function loadPayerHistories(storeId: string): Promise<PayerHistory[]> {
  const rows = await prisma.rawRecord.findMany({
    where: { storeId, app: "COURIERIFY", entity: "SETTLEMENT", deletedAt: null },
    select: { payload: true },
  });
  return payerHistories(rows.map((r) => readPayout((r.payload ?? {}) as Record<string, unknown>)).filter((p) => p !== null));
}

/** Every Courierify settlement statement on the store, with its deductions. */
export async function loadStatements(storeId: string): Promise<Statement[]> {
  const rows = await prisma.rawRecord.findMany({
    where: { storeId, app: "COURIERIFY", entity: "SETTLEMENT", deletedAt: null },
    select: { payload: true },
  });
  return rows.map((r) => readStatement((r.payload ?? {}) as Record<string, unknown>)).filter((s): s is Statement => s !== null);
}
