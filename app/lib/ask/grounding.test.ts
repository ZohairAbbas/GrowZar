import { describe, expect, it } from "vitest";

import { ALL_DROPPED, ground, numbersIn, sourceNumbers } from "./grounding";
import type { ToolResult } from "./types";

const result = (rows: ToolResult["rows"], notes: string[] = []): ToolResult => ({
  tool: "breakdown",
  status: "ok",
  title: "Profit by product",
  columns: [],
  rows,
  meta: { period: { from: "2026-09-01", to: "2026-09-30", days: 30 }, stores: [{ id: "s1", name: "Shop" }], rules: [], gaps: ["COGS incomplete on 189 delivered order(s)"], notes },
  link: null,
});

const SOURCES = sourceNumbers([result([{ key: "1", label: "Hijab", profit: -36877.29, delivery_rate: 93.25, orders: 1710 }, { key: "2", label: "Sleeves", profit: 1710860.2 }], ["5.9% of returns"])]);

describe("numbersIn", () => {
  it("reads separators, decimals, signs, scales, percents and Urdu digits", () => {
    expect(numbersIn("PKR -36,877.29 and 1,71,086 and 93.3% and 1.7 million and ۱۲٫۵").map((f) => f.value)).toEqual([-36877.29, 171086, 93.3, 1_700_000, 12.5]);
  });
  it("ignores table citations and order names, and reads dates by their parts", () => {
    expect(numbersIn("Orders (table 1) and tables 2 and 3, order #1234, 2026-09-30").map((f) => f.value)).toEqual([2026, 9, 30]);
  });
});

describe("ground", () => {
  it("passes figures the tools returned, however they are written", () => {
    for (const text of [
      "The biggest loss was Hijab at PKR -36,877.29 (table 1).",
      "Hijab lost PKR 36,877 (table 1).",
      "Sleeves made PKR 1.7 million.",
      "Sleeves made about 17 lakh rupees.",
      "Delivery rate 93.3%, or about 93%.",
      "1,710 orders from 2026-09-01 to 2026-09-30, the last 30 days.",
      "Costs are missing on 189 delivered orders, and 5.9% of returns came from repeat returners.",
      "Lahore mein 3 couriers hain, aur 2 ka data kam hai.",
    ]) {
      expect(ground(text, SOURCES), text).toMatchObject({ grounded: true, text });
    }
  });

  it("drops the sentence with a number no tool returned, keeps the rest, and says what it dropped", () => {
    const g = ground("Hijab lost PKR 36,877 (table 1). That is 12% of your revenue. Delivery rate was 93.3%.", SOURCES);
    expect(g.grounded).toBe(false);
    expect(g.text).toBe("Hijab lost PKR 36,877 (table 1). Delivery rate was 93.3%.");
    expect(g.unmatched).toEqual(["12%"]);
    expect(g.dropped).toEqual(["That is 12% of your revenue."]);
  });

  it("does not let a sum or a conversion through", () => {
    // −36,877.29 + 1,710,860.20 = 1,673,982.91: computed by the model, so not grounded.
    expect(ground("Together they made PKR 1,673,982.91.", SOURCES).grounded).toBe(false);
    expect(ground("That is about USD 6,100.", SOURCES).grounded).toBe(false);
    expect(ground("Delivery rate was 95%.", SOURCES).grounded).toBe(false);
  });

  it("keeps list structure and falls back to a pointer at the table when nothing is left", () => {
    expect(ground("- Hijab: PKR 36,877\n- Sleeves: PKR 9,999", SOURCES).text).toBe("- Hijab: PKR 36,877");
    expect(ground("Profit was PKR 123,456.", SOURCES).text).toBe(ALL_DROPPED);
  });

  it("lets small counts through but not small percentages", () => {
    expect(ground("Two of the 4 products lost money.", SOURCES).grounded).toBe(true);
    expect(ground("Returns rose 4%.", SOURCES).grounded).toBe(false);
  });
});
