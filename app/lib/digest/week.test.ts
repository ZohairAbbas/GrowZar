import { describe, expect, it } from "vitest";

import { isSendTime, nextSendDay, weekLabel, weekOf } from "./week";

const KHI = "Asia/Karachi"; // UTC+5
const DXB = "Asia/Dubai"; // UTC+4

describe("weekOf", () => {
  it("is the local Monday on or before the moment", () => {
    // Monday 2026-10-19 00:30 in Karachi is still Sunday in UTC.
    expect(weekOf(new Date("2026-10-18T19:30:00Z"), KHI)).toBe("2026-10-19");
    expect(weekOf(new Date("2026-10-18T19:30:00Z"), "UTC")).toBe("2026-10-12");
    // Wednesday and Sunday belong to the Monday before them.
    expect(weekOf(new Date("2026-10-14T12:00:00Z"), KHI)).toBe("2026-10-12");
    expect(weekOf(new Date("2026-10-18T12:00:00Z"), KHI)).toBe("2026-10-12");
  });
});

describe("isSendTime", () => {
  it("is Monday from 09:00 local until midnight", () => {
    expect(isSendTime(new Date("2026-10-19T03:59:00Z"), KHI)).toBe(false); // 08:59
    expect(isSendTime(new Date("2026-10-19T04:00:00Z"), KHI)).toBe(true); // 09:00
    expect(isSendTime(new Date("2026-10-19T18:59:00Z"), KHI)).toBe(true); // 23:59
    expect(isSendTime(new Date("2026-10-19T19:00:00Z"), KHI)).toBe(false); // Tuesday 00:00
  });

  it("follows each store's own clock", () => {
    const at = new Date("2026-10-19T04:30:00Z"); // 09:30 Karachi, 08:30 Dubai
    expect(isSendTime(at, KHI)).toBe(true);
    expect(isSendTime(at, DXB)).toBe(false);
  });
});

describe("nextSendDay", () => {
  it("is today before 09:00 on a Monday, else the coming Monday", () => {
    expect(nextSendDay(new Date("2026-10-19T03:00:00Z"), KHI)).toBe("2026-10-19");
    expect(nextSendDay(new Date("2026-10-19T05:00:00Z"), KHI)).toBe("2026-10-26");
    expect(nextSendDay(new Date("2026-10-14T12:00:00Z"), KHI)).toBe("2026-10-19");
  });
});

it("labels a week by its Monday", () => {
  expect(weekLabel("2026-10-19")).toBe("Monday 19 October");
});
