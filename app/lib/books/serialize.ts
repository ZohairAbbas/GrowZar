/**
 * Remix serializes loader data as JSON, which has no bigint. Books amounts are
 * bigint on the server, so loaders pass them through `jsonSafe` (bigint →
 * decimal string, Date → ISO string) and the browser turns them back with
 * `BigInt(s)` only where it does arithmetic.
 */

export type JsonSafe<T> = T extends bigint
  ? string
  : T extends Date
    ? string
    : T extends Array<infer U>
      ? JsonSafe<U>[]
      : T extends Map<any, any>
        ? never
        : T extends object
          ? { [K in keyof T]: JsonSafe<T[K]> }
          : T;

export function jsonSafe<T>(value: T): JsonSafe<T> {
  return walk(value) as JsonSafe<T>;
}

function walk(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(walk);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = walk(x);
    return out;
  }
  return v;
}

/** Back to bigint on the client; "" or junk → 0n. */
export function big(s: string | number | bigint | null | undefined): bigint {
  if (typeof s === "bigint") return s;
  if (typeof s === "number") return Number.isSafeInteger(s) ? BigInt(s) : 0n;
  if (typeof s === "string" && /^-?\d+$/.test(s)) return BigInt(s);
  return 0n;
}
