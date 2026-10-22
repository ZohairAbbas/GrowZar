import { writeFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { crc32, zip } from "../zip.server";

describe("zip", () => {
  it("crc32 matches the standard check value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });
  it("writes entries that inflate back to their content", () => {
    const z = zip([{ name: "a.csv", data: "﻿a,b\r\n1,2\r\n" }, { name: "Ünïcode/ok.txt", data: "x".repeat(10000) }, { name: "empty.txt", data: "" }]);
    if (process.env.ZIP_OUT) writeFileSync(process.env.ZIP_OUT, z);
    // First local header: signature, then the deflated data after name.
    expect(z.readUInt32LE(0)).toBe(0x04034b50);
    const nameLen = z.readUInt16LE(26);
    const compSize = z.readUInt32LE(18);
    const data = inflateRawSync(z.subarray(30 + nameLen, 30 + nameLen + compSize));
    expect(data.toString("utf8")).toBe("﻿a,b\r\n1,2\r\n");
    expect(z.readUInt32LE(z.length - 22)).toBe(0x06054b50);
    expect(z.readUInt16LE(z.length - 22 + 10)).toBe(3);
  });
});
