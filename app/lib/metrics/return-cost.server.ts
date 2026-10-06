import { prisma } from "../db.server";
import { returnCostOf, type ReturnCost } from "./return-cost";

/** The store's measured cost of a return, from every returned Courierify parcel on record. */
export async function loadReturnCost(storeId: string, currency: string | null): Promise<ReturnCost | null> {
  if (!currency) return null;
  const rows = await prisma.rawRecord.findMany({
    where: { storeId, app: "COURIERIFY", entity: "PARCEL", deletedAt: null, payload: { path: ["status"], equals: "returned" } },
    select: { payload: true },
  });
  return returnCostOf(
    rows.map((r) => {
      const p = (r.payload ?? {}) as Record<string, unknown>;
      return { status: String(p.status ?? ""), deliveryFee: p.deliveryFee, reversalFee: p.reversalFee, returnChargeBasis: p.returnChargeBasis };
    }),
    currency,
  );
}
