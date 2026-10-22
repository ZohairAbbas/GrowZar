/** Bill status in words, shared by the server and the screens (browser-safe). */

export type BillState = "draft" | "awaiting" | "partly_paid" | "paid" | "overdue" | "cancelled";

export const BILL_STATE: Record<BillState, { label: string; tone?: "success" | "attention" | "critical" | "info" }> = {
  draft: { label: "Draft", tone: "attention" },
  awaiting: { label: "Awaiting payment", tone: "info" },
  partly_paid: { label: "Partly paid", tone: "attention" },
  paid: { label: "Paid", tone: "success" },
  overdue: { label: "Overdue", tone: "critical" },
  cancelled: { label: "Cancelled" },
};

export function billState(status: string, total: bigint, paid: bigint, dueDate: string | null | undefined, today: string): BillState {
  if (status === "draft") return "draft";
  if (status === "cancelled") return "cancelled";
  if (paid >= total) return "paid";
  if (dueDate && dueDate < today) return "overdue";
  return paid > 0n ? "partly_paid" : "awaiting";
}
