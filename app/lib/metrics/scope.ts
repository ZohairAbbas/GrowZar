/**
 * The section filter bar's courier and city (Phase 4b, D2). Pure.
 *
 * A filter is a value of the same keys the roll-ups group by (`byCourier`,
 * `byCity`), so picking a row in a breakdown and filtering by it select the
 * same orders, and a drill-down keeps working however deep it goes.
 */
import { byCity, byCourier, type RollupOrder } from "./rollups";

export type Scope = { courier: string | null; city: string | null };

export const NO_SCOPE: Scope = { courier: null, city: null };

const clean = (v: string | null) => {
  const t = v?.trim();
  return t && t.length <= 120 ? t : null;
};

export function parseScope(params: URLSearchParams): Scope {
  return { courier: clean(params.get("courier")), city: clean(params.get("city")) };
}

export const isScoped = (s: Scope) => s.courier !== null || s.city !== null;

export function scopeQuery(s: Scope): string {
  const q = new URLSearchParams();
  if (s.courier) q.set("courier", s.courier);
  if (s.city) q.set("city", s.city);
  return q.toString();
}

export function inScope(o: RollupOrder, s: Scope): boolean {
  if (s.courier && byCourier(o)[0] !== s.courier) return false;
  if (s.city && byCity(o)[0] !== s.city) return false;
  return true;
}

/**
 * The same predicate as a database filter on `order_grain`, for screens that
 * page through orders rather than load them all. Mirrors `byCourier` and
 * `byCity` exactly, including "unknown", "unmapped" and "no city".
 */
export function scopeWhere(s: Scope) {
  const and: object[] = [];
  if (s.courier) and.push(s.courier === "unknown" ? { courier: null } : { courier: s.courier });
  if (s.city) {
    if (s.city === "unmapped") and.push({ city: null }, { OR: [{ parcelCount: { gt: 0 } }, { cityRaw: { not: null } }] });
    else if (s.city === "no city") and.push({ city: null, parcelCount: 0, cityRaw: null });
    else and.push({ city: s.city });
  }
  return and.length ? { AND: and } : {};
}
