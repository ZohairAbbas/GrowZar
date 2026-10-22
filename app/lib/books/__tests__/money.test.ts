import { describe, expect, it } from "vitest";
import { currencyDecimals, formatAmount, minorFromString, parseAmount, toInputString } from "../money";

describe("parseAmount", () => {
  it.each([
    ["12500", 1250000n],
    ["12,500", 1250000n],
    ["12,500.5", 1250050n],
    ["12,500.50", 1250050n],
    [" 1 250 ", 125000n],
    ["12.5k", 1250000n],
    ["12.5K", 1250000n],
    ["1.2m", 120000000n],
    ["0.01", 1n],
    [".5", 50n],
    ["0", 0n],
    ["1.234k", 123400n],
    ["1.23456k", 123456n],
    ["1000.", 100000n],
    ["1,25,000", 12500000n],
  ])("%s → %s", (input, expected) => {
    expect(parseAmount(input, 2)).toBe(expected);
  });

  it.each(["", " ", "-5", "abc", "12.555", "1.234567k", "1..2", "1.2.3", "k", ".", "12e3", "1,2.3.4"])(
    "rejects %j",
    (input) => {
      expect(parseAmount(input, 2)).toBeNull();
    },
  );

  it("respects zero-decimal currencies", () => {
    expect(parseAmount("1500", 0)).toBe(1500n);
    expect(parseAmount("1500.5", 0)).toBeNull();
    expect(parseAmount("1500.0", 0)).toBe(1500n);
  });

  it("handles three-decimal currencies", () => {
    expect(parseAmount("1.005", 3)).toBe(1005n);
  });

  it("never loses precision on large amounts", () => {
    expect(parseAmount("90071992547409.93", 2)).toBe(9007199254740993n);
  });
});

describe("formatAmount", () => {
  it("groups thousands and trims a zero fraction", () => {
    expect(formatAmount(125000000n, 2)).toBe("1,250,000");
    expect(formatAmount(1250050n, 2)).toBe("12,500.50");
    expect(formatAmount(0n, 2)).toBe("0");
    expect(formatAmount(5n, 2)).toBe("0.05");
  });

  it("shows negatives with a true minus or brackets", () => {
    expect(formatAmount(-100000n, 2)).toBe("−1,000");
    expect(formatAmount(-100000n, 2, { negative: "brackets" })).toBe("(1,000)");
  });

  it("can prefix the currency and keep the fraction", () => {
    expect(formatAmount(100000n, 2, { currency: "PKR", trimZeroFraction: false })).toBe("PKR 1,000.00");
  });

  it("round-trips through the input form", () => {
    for (const v of [0n, 1n, 99n, 100n, 1250050n, -1250050n, 123456789012n]) {
      const s = toInputString(v, 2);
      expect(s.startsWith("-") ? -parseAmount(s.slice(1), 2)! : parseAmount(s, 2)).toBe(v);
    }
  });
});

describe("minorFromString / currencyDecimals", () => {
  it("accepts only integer strings", () => {
    expect(minorFromString("1250000")).toBe(1250000n);
    expect(minorFromString("-5")).toBe(-5n);
    expect(minorFromString("1.5")).toBeNull();
    expect(minorFromString("")).toBeNull();
    expect(minorFromString(null)).toBeNull();
  });

  it("knows decimal places", () => {
    expect(currencyDecimals("PKR")).toBe(2);
    expect(currencyDecimals("jpy")).toBe(0);
    expect(currencyDecimals("KWD")).toBe(3);
  });
});

describe("tax arithmetic", async () => {
  const { formatRate, parseRate, splitInclusive, taxOn } = await import("../tax");
  it("rates", () => {
    expect(formatRate(1800)).toBe("18%");
    expect(formatRate(450)).toBe("4.5%");
    expect(formatRate(25)).toBe("0.25%");
    expect(formatRate(0)).toBe("0%");
    expect(parseRate("18")).toBe(1800);
    expect(parseRate(" 4.5 %")).toBe(450);
    expect(parseRate("0.25")).toBe(25);
    expect(parseRate("1.234")).toBeNull();
    expect(parseRate("-1")).toBeNull();
    expect(parseRate("abc")).toBeNull();
    expect(parseRate("1001")).toBeNull();
  });
  it("tax on an amount, half up", () => {
    expect(taxOn(10000n, 1800)).toBe(1800n);
    expect(taxOn(1n, 1800)).toBe(0n);
    expect(taxOn(3n, 1800)).toBe(1n); // 0.54 → 1
    expect(taxOn(0n, 1800)).toBe(0n);
    expect(taxOn(999n, 0)).toBe(0n);
  });
  it("splitting an amount that includes tax always adds back up", () => {
    expect(splitInclusive(11800n, 1800)).toEqual({ net: 10000n, tax: 1800n });
    for (let g = 1n; g < 3000n; g += 7n) {
      for (const bp of [25, 450, 500, 1500, 1800]) {
        const { net, tax } = splitInclusive(g, bp);
        expect(net + tax).toBe(g);
        expect(tax >= 0n && net >= 0n).toBe(true);
        // Within one minor unit of the exact tax.
        const exact = (Number(g) * bp) / (10000 + bp);
        expect(Math.abs(Number(tax) - exact)).toBeLessThanOrEqual(0.5);
      }
    }
  });
});

describe("line figures", async () => {
  const { lineFigures, lineToInput } = await import("../tax");
  it("with and without tax included, and a typed-over tax", () => {
    expect(lineFigures(11800n, 1800, true)).toEqual({ net: 10000n, tax: 1800n });
    expect(lineFigures(10000n, 1800, false)).toEqual({ net: 10000n, tax: 1800n });
    expect(lineFigures(11800n, null, true)).toEqual({ net: 11800n, tax: 0n });
    expect(lineFigures(11800n, 1800, true, 1799n)).toEqual({ net: 10001n, tax: 1799n });
    expect(lineFigures(10000n, 1800, false, 1799n)).toEqual({ net: 10000n, tax: 1799n });
  });
  it("round-trips a saved line", () => {
    for (const [entered, bp] of [[11800n, 1800], [997n, 1800], [12345n, 450]] as const) {
      const f = lineFigures(entered, bp, true);
      expect(lineToInput(f.net, { rateBp: bp, amount: String(f.tax) })).toEqual({ entered, override: null });
    }
    expect(lineToInput(10001n, { rateBp: 1800, amount: "1799" })).toEqual({ entered: 11800n, override: 1799n });
    expect(lineToInput(500n, null)).toEqual({ entered: 500n, override: null });
  });
});

describe("foreign currency arithmetic", async () => {
  const { formatFxRate, impliedRate, parseFxRate, toBookAmount } = await import("../fx");
  it("rates", () => {
    expect(parseFxRate("279.5")).toBe(27950000000n);
    expect(parseFxRate("0.00360000")).toBe(360000n);
    expect(parseFxRate("1,000")).toBe(100000000000n);
    expect(parseFxRate("0")).toBeNull();
    expect(parseFxRate("-1")).toBeNull();
    expect(parseFxRate("1.123456789")).toBeNull();
    expect(formatFxRate(27950000000n)).toBe("279.5");
    expect(formatFxRate(100000000n)).toBe("1");
  });
  it("converts across different decimals, rounding half away from zero", () => {
    // USD 100.00 at 279.5 → PKR 27,950.00
    expect(toBookAmount(10000n, "USD", 2, parseFxRate("279.5")!)).toBe(2795000n);
    // A card balance (negative) converts with its sign.
    expect(toBookAmount(-10000n, "USD", 2, parseFxRate("279.5")!)).toBe(-2795000n);
    // KWD has 3 decimals: KWD 1.000 at 905.25 → PKR 905.25
    expect(toBookAmount(1000n, "KWD", 2, parseFxRate("905.25")!)).toBe(90525n);
    // JPY has none: JPY 1,000 at 1.875 → PKR 1,875.00
    expect(toBookAmount(1000n, "JPY", 2, parseFxRate("1.875")!)).toBe(187500n);
    // Half a paisa rounds away from zero.
    expect(toBookAmount(1n, "USD", 2, parseFxRate("0.5")!)).toBe(1n);
    expect(toBookAmount(-1n, "USD", 2, parseFxRate("0.5")!)).toBe(-1n);
  });
  it("the rate a pair of amounts implies", () => {
    expect(formatFxRate(impliedRate(2795000n, 2, 10000n, "USD")!)).toBe("279.5");
    expect(impliedRate(100n, 2, 0n, "USD")).toBeNull();
  });
});
