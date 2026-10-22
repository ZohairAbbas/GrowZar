/**
 * Books chart of accounts: the ecommerce template, account kinds and the
 * plain-language words shown to owners.
 *
 * Codes leave room: 1000s assets, 2000s liabilities, 3000s equity, 4000s
 * income, 5000s cost of sales, 6000s expenses. Money accounts (bank, cash,
 * wallets, cards) are not in the template; setup creates the ones the merchant
 * actually has.
 */

export type AccountType = "asset" | "liability" | "equity" | "income" | "expense";

export const ACCOUNT_TYPES: AccountType[] = ["asset", "liability", "equity", "income", "expense"];

/** Accounts the engine posts to by itself. Renamable, never archivable. */
export type SystemKey =
  | "opening_balance"
  | "owner_capital"
  | "owner_drawings"
  | "retained_earnings"
  | "receivables"
  | "payables"
  | "stock"
  | "cogs"
  | "rounding";

export interface TemplateAccount {
  code: string;
  name: string;
  type: AccountType;
  subtype: string;
  systemKey?: SystemKey;
}

export const CHART_TEMPLATE: TemplateAccount[] = [
  { code: "1100", name: "Owed by couriers", type: "asset", subtype: "receivable" },
  { code: "1110", name: "Owed by payment gateways", type: "asset", subtype: "receivable" },
  { code: "1120", name: "Owed by customers", type: "asset", subtype: "receivable", systemKey: "receivables" },
  { code: "1200", name: "Stock", type: "asset", subtype: "stock", systemKey: "stock" },
  { code: "1300", name: "Tax you can claim back", type: "asset", subtype: "tax" },
  { code: "1400", name: "Advances and deposits", type: "asset", subtype: "other" },

  { code: "2010", name: "Owed to suppliers", type: "liability", subtype: "payable", systemKey: "payables" },
  { code: "2100", name: "Sales tax to pay", type: "liability", subtype: "tax" },
  { code: "2110", name: "Withholding tax to pay", type: "liability", subtype: "tax" },
  { code: "2200", name: "Loans", type: "liability", subtype: "loan" },

  { code: "3000", name: "Owner's capital", type: "equity", subtype: "equity", systemKey: "owner_capital" },
  { code: "3100", name: "Owner's drawings", type: "equity", subtype: "equity", systemKey: "owner_drawings" },
  { code: "3200", name: "Opening balance adjustment", type: "equity", subtype: "equity", systemKey: "opening_balance" },
  { code: "3900", name: "Retained earnings", type: "equity", subtype: "equity", systemKey: "retained_earnings" },

  { code: "4000", name: "Sales", type: "income", subtype: "sales" },
  { code: "4010", name: "Shipping charged", type: "income", subtype: "sales" },
  { code: "4020", name: "Discounts given", type: "income", subtype: "sales" },
  { code: "4030", name: "Returns", type: "income", subtype: "sales" },
  { code: "4900", name: "Other income", type: "income", subtype: "other" },

  { code: "5000", name: "Cost of what you sold", type: "expense", subtype: "cost_of_sales", systemKey: "cogs" },
  { code: "5010", name: "Delivery charges", type: "expense", subtype: "cost_of_sales" },
  { code: "5020", name: "Return charges", type: "expense", subtype: "cost_of_sales" },
  { code: "5030", name: "Packaging", type: "expense", subtype: "cost_of_sales" },
  { code: "5040", name: "Payment gateway fees", type: "expense", subtype: "cost_of_sales" },

  { code: "6000", name: "Advertising", type: "expense", subtype: "operating" },
  { code: "6010", name: "Salaries and wages", type: "expense", subtype: "operating" },
  { code: "6020", name: "Rent", type: "expense", subtype: "operating" },
  { code: "6030", name: "Utilities and internet", type: "expense", subtype: "operating" },
  { code: "6040", name: "Software and apps", type: "expense", subtype: "operating" },
  { code: "6050", name: "Bank charges", type: "expense", subtype: "operating" },
  { code: "6060", name: "Tax withheld by others", type: "expense", subtype: "operating" },
  { code: "6070", name: "Office and supplies", type: "expense", subtype: "operating" },
  { code: "6080", name: "Travel and transport", type: "expense", subtype: "operating" },
  { code: "6090", name: "Professional fees", type: "expense", subtype: "operating" },
  { code: "6100", name: "Stock lost or damaged", type: "expense", subtype: "operating" },
  { code: "6900", name: "Other expenses", type: "expense", subtype: "operating" },
  { code: "6990", name: "Rounding", type: "expense", subtype: "operating", systemKey: "rounding" },
];

/** Where money lives. Setup offers these; each becomes an account. */
export const MONEY_KINDS = [
  { subtype: "bank", label: "Bank account", type: "asset" as const, codeBase: 1000, example: "Main bank account" },
  { subtype: "cash", label: "Cash", type: "asset" as const, codeBase: 1050, example: "Cash in hand" },
  { subtype: "mobile_wallet", label: "Mobile wallet", type: "asset" as const, codeBase: 1060, example: "JazzCash" },
  { subtype: "ad_wallet", label: "Ad wallet (prepaid)", type: "asset" as const, codeBase: 1070, example: "Meta ad wallet" },
  { subtype: "card", label: "Credit card", type: "liability" as const, codeBase: 2050, example: "Business credit card" },
];

export type MoneySubtype = (typeof MONEY_KINDS)[number]["subtype"];

export const MONEY_SUBTYPES: string[] = MONEY_KINDS.map((k) => k.subtype);

export function isMoneySubtype(subtype: string): boolean {
  return MONEY_SUBTYPES.includes(subtype);
}

/** Debit-normal accounts grow with debits. */
export function isDebitNormal(type: AccountType | string): boolean {
  return type === "asset" || type === "expense";
}

/**
 * A ledger amount (+debit / −credit) as the merchant reads it: positive when
 * the account holds its normal kind of balance (money in the bank, a debt
 * owed to you, sales earned, a liability owed).
 */
export function naturalBalance(type: AccountType | string, ledgerAmount: bigint): bigint {
  return isDebitNormal(type) ? ledgerAmount : -ledgerAmount;
}

export const TYPE_LABELS: Record<AccountType, { owner: string; accountant: string }> = {
  asset: { owner: "What you have", accountant: "Assets" },
  liability: { owner: "What you owe", accountant: "Liabilities" },
  equity: { owner: "Owner's money", accountant: "Equity" },
  income: { owner: "Money earned", accountant: "Income" },
  expense: { owner: "Money spent", accountant: "Expenses" },
};

export const SUBTYPE_LABELS: Record<string, string> = {
  bank: "Bank account",
  cash: "Cash",
  mobile_wallet: "Mobile wallet",
  ad_wallet: "Ad wallet",
  card: "Credit card",
  receivable: "Owed to you",
  payable: "You owe",
  stock: "Stock",
  tax: "Tax",
  loan: "Loan",
  equity: "Owner's money",
  sales: "Sales",
  cost_of_sales: "Cost of sales",
  operating: "Running costs",
  other: "Other",
};

/** Subtypes a person may pick when adding an account of a given type. */
export const SUBTYPES_FOR_TYPE: Record<AccountType, string[]> = {
  asset: ["bank", "cash", "mobile_wallet", "ad_wallet", "receivable", "stock", "tax", "other"],
  liability: ["card", "payable", "tax", "loan", "other"],
  equity: ["equity"],
  income: ["sales", "other"],
  expense: ["cost_of_sales", "operating"],
};

/** Next free code in a type's range, after `base`, skipping used ones. */
export function nextCode(used: Iterable<string>, base: number, limit = 99): string {
  const taken = new Set(used);
  for (let i = 0; i <= limit; i++) {
    const c = String(base + i);
    if (!taken.has(c)) return c;
  }
  // Fall back to a 5-digit code; the range is generous enough this is rare.
  for (let i = 0; i < 1000; i++) {
    const c = `${base}${i}`;
    if (!taken.has(c)) return c;
  }
  throw new Error("No free account code");
}

export const CODE_BASE_FOR_TYPE: Record<AccountType, number> = {
  asset: 1500,
  liability: 2300,
  equity: 3300,
  income: 4100,
  expense: 6200,
};
