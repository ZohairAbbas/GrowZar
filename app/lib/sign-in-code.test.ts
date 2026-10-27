import { describe, expect, it } from "vitest";

import { codeFailure, readCode } from "./sign-in-code";

describe("readCode", () => {
  it("takes six digits, with the space the email shows or a dash", () => {
    expect(readCode("123456")).toBe("123456");
    expect(readCode(" 123 456 ")).toBe("123456");
    expect(readCode("123-456")).toBe("123456");
  });

  it("refuses anything else", () => {
    expect(readCode("12345")).toBeNull();
    expect(readCode("1234567")).toBeNull();
    expect(readCode("12a456")).toBeNull();
    expect(readCode("")).toBeNull();
  });
});

describe("codeFailure", () => {
  it("names an expired code and a used-up one", () => {
    expect(codeFailure("OTP expired")).toMatch(/expired/);
    expect(codeFailure("Too many attempts")).toMatch(/Too many/);
  });

  it("says a wrong code didn't match, whatever else came back", () => {
    expect(codeFailure("Invalid OTP")).toMatch(/didn't match/);
    expect(codeFailure(null)).toMatch(/didn't match/);
  });
});
