/**
 * Books reads Growzar's data only through its connectors (B3), never by
 * importing metrics, insights or finance code, so its numbers can't drift with
 * theirs. As Financify's isolation test: every Books file imports only Books
 * files and this list.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ALLOWED = new Set(["@prisma/client", "~/lib/db.server", "zod", "vitest", "pg"]);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(n) ? [p] : [];
  });
}

describe("Books isolation", () => {
  it("imports only Books files and its allowlist", () => {
    const outside: string[] = [];
    for (const f of files(ROOT)) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/^\s*(?:import|export)\b[^;]*?\sfrom\s+"([^"]+)"|\bimport\("([^"]+)"\)/gm)) {
        const spec = (m[1] ?? m[2])!;
        if (spec.startsWith(".") || spec.startsWith("node:") || ALLOWED.has(spec)) continue;
        outside.push(`${f.slice(ROOT.length)}: ${spec}`);
      }
    }
    expect(outside).toEqual([]);
  });
});
