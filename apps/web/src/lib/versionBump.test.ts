import { describe, expect, it } from "vitest";
import { bumpVersionString, substituteVersionInUrl } from "./versionBump";

describe("bumpVersionString", () => {
  it("bumps the last numeric segment", () => {
    expect(bumpVersionString("1.2.3")).toBe("1.2.4");
    expect(bumpVersionString("10")).toBe("11");
    expect(bumpVersionString("2.0")).toBe("2.1");
  });

  it("preserves suffixes and zero-padding", () => {
    expect(bumpVersionString("1.0.0-beta2")).toBe("1.0.0-beta3");
    expect(bumpVersionString("1.09")).toBe("1.10");
    expect(bumpVersionString("v1.2.3")).toBe("v1.2.4");
    expect(bumpVersionString("1.2.3b")).toBe("1.2.4b");
  });

  it("returns empty for strings without digits", () => {
    expect(bumpVersionString("")).toBe("");
    expect(bumpVersionString("latest")).toBe("");
  });
});

describe("substituteVersionInUrl", () => {
  it("rewrites embedded versions", () => {
    expect(
      substituteVersionInUrl("https://dl.example.com/app-1.2.3.msi", "1.2.3", "1.2.4"),
    ).toBe("https://dl.example.com/app-1.2.4.msi");
  });

  it("leaves URLs without the version untouched", () => {
    expect(
      substituteVersionInUrl("https://dl.example.com/latest.msi", "1.2.3", "1.2.4"),
    ).toBe("https://dl.example.com/latest.msi");
  });

  it("is a no-op for empty or unchanged versions", () => {
    expect(substituteVersionInUrl("https://x/app-1.2.3.msi", "1.2.3", "")).toBe(
      "https://x/app-1.2.3.msi",
    );
    expect(substituteVersionInUrl("", "1.2.3", "1.2.4")).toBe("");
  });
});
