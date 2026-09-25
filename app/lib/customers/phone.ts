import { parsePhoneNumberFromString } from "libphonenumber-js";

/**
 * Phone normalisation to E.164 (API-CONTRACT §3, rule #19).
 *
 * More than twenty distinct phone formats exist across the suite, and
 * Courierify groups its customers by the raw string — so its customer count is
 * a count of *spellings*, not of people. That is why no app's customer count is
 * ever displayed in Growzar, and why Growzar keeps its own customer record.
 *
 * The raw value is always kept beside the normalised one. A number Growzar
 * could not parse is still the number the merchant has, and throwing it away
 * to keep the column clean would lose the only way to reach that buyer.
 */
export type NormalizedPhone = {
  /** `+923001234567`, or null when it could not be parsed confidently. */
  e164: string | null;
  /** Exactly what the app sent, always. */
  raw: string;
  /** Why normalisation failed, when it did — worth seeing in aggregate. */
  problem?: "empty" | "unparseable" | "invalid" | "no_region";
};

/**
 * `defaultRegion` is the store's country, used only for numbers written the
 * local way (`0300-1234567`). A number already in international form is
 * region-independent and normalises without one.
 */
export function normalizePhone(
  raw: string | null | undefined,
  defaultRegion?: string | null,
): NormalizedPhone {
  const value = typeof raw === "string" ? raw.trim() : "";

  if (!value) return { e164: null, raw: value, problem: "empty" };

  // Only a leading `+` is region-independent. `00` is an international access
  // code in much of the world but not all of it — North America dials `011` —
  // so `00923…` still needs to know where it was dialled from. And a plain
  // local number like `0300-1234567` is a different person in every country.
  // Guessing a region here is exactly the class of silent wrong answer rule #4
  // exists to prevent, so it is refused and reported instead.
  const looksInternational = value.startsWith("+");
  if (!looksInternational && !defaultRegion) {
    return { e164: null, raw: value, problem: "no_region" };
  }

  try {
    const parsed = parsePhoneNumberFromString(
      value,
      (defaultRegion as never) ?? undefined,
    );

    if (!parsed) return { e164: null, raw: value, problem: "unparseable" };
    if (!parsed.isValid()) return { e164: null, raw: value, problem: "invalid" };

    return { e164: parsed.number, raw: value };
  } catch {
    return { e164: null, raw: value, problem: "unparseable" };
  }
}

/**
 * Email is the other identity key, and it needs its own gentle normalising:
 * addresses arrive with stray capitals and whitespace, and `Owner@Acme.PK` and
 * `owner@acme.pk` are one person.
 *
 * Only case and whitespace are touched. Gmail's dots-and-plus rules are NOT
 * applied: they are true of Gmail and false of most other hosts, and silently
 * merging two addresses that a merchant sees as different people is worse than
 * leaving them apart.
 */
export function normalizeEmail(raw: string | null | undefined): string | null {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!value || !value.includes("@")) return null;
  return value;
}

/**
 * The country to parse local numbers against, when the apps have not said.
 *
 * §6.1 echoes `shopTimezone` and `shopCurrency` but not the shop's country,
 * which phone normalisation needs. Until the contract carries it (raised in
 * the Phase 1 report), a timezone implies a country closely enough for the
 * markets this suite serves — and every inference is recorded as an inference
 * on the store, so nobody later mistakes it for something an app said.
 */
const TIMEZONE_COUNTRIES: Record<string, string> = {
  "Asia/Karachi": "PK",
  "Asia/Dubai": "AE",
  "Asia/Riyadh": "SA",
  "Asia/Kolkata": "IN",
  "Asia/Dhaka": "BD",
  "Europe/London": "GB",
  "America/New_York": "US",
  "America/Chicago": "US",
  "America/Los_Angeles": "US",
};

export function countryFromTimezone(timezone: string | null): string | null {
  if (!timezone) return null;
  return TIMEZONE_COUNTRIES[timezone] ?? null;
}
