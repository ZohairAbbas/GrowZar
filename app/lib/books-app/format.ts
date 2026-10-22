import { TYPE_LABELS, type AccountType } from "../books/chart";
import { formatAmount } from "../books/money";
import type { BookView } from "../books/books.server";

/**
 * Money and words as each viewer reads them (B2): owners see "What you have"
 * and −1,000; an accountant sees "Assets" and (1,000), as in Financify's
 * accountant view, decided here by role instead of a toggle.
 */
export const isAccountantRole = (role: string) => role.split(",").some((r) => r.trim() === "accountant");

export function money(book: Pick<BookView, "decimals">, minor: bigint, accountant: boolean): string {
  return formatAmount(minor, book.decimals, { negative: accountant ? "brackets" : "minus", trimZeroFraction: false });
}

export function typeLabel(type: AccountType, accountant: boolean): string {
  return accountant ? TYPE_LABELS[type].accountant : TYPE_LABELS[type].owner;
}
