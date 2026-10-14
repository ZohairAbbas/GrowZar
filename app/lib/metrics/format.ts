/** "1234567.5" → "1,234,567.50", without passing through a float. */
export function formatAmount(amount: string): string {
  const negative = amount.startsWith("-");
  const [whole = "0", fraction = ""] = amount.replace("-", "").split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "−" : ""}${grouped}.${fraction.padEnd(2, "0").slice(0, 2)}`;
}
