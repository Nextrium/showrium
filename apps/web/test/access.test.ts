import { describe, expect, it } from "vitest";
import { ROLES } from "@nextrium/db";
import { canManageApiKeys, isEmailAllowed } from "@nextrium/core";
import { isRateLimited } from "../worker/rate-limit";

describe("beta allowlist", () => {
  it.each([
    ["anyone@x.com", undefined, false],
    ["anyone@x.com", "", false],
    ["anyone@x.com", " , ", false],
    ["anyone@x.com", "*", true],
    ["ada@example.com", "ada@example.com", true],
    ["ADA@Example.com ", "ada@example.com", true],
    ["bob@example.com", "ada@example.com", false],
    ["ada@example.com", "@example.com", true],
    ["ada@evilexample.com", "@example.com", false],
    ["ada@sub.example.com", "@example.com", false],
    ["ada@example.com.evil.io", "@example.com", false],
    ["not-an-email", "*", false],
    ["ada@nextrium.com", "x@y.com, @nextrium.com", true],
  ])("%s with %j -> %s", (email, list, expected) => {
    expect(isEmailAllowed(email, list)).toBe(expected);
  });
});

describe("API key management permission matrix", () => {
  for (const role of ROLES) {
    const expected = role === "owner" || role === "admin";
    it(`signed-in ${role}: ${expected ? "allowed" : "denied"}`, () => {
      expect(canManageApiKeys("user", role)).toBe(expected);
    });
    it(`API key carrying ${role}: denied`, () => {
      expect(canManageApiKeys("api_key", role)).toBe(false);
    });
  }
  it("unknown or empty role: denied", () => {
    expect(canManageApiKeys("user", "superuser")).toBe(false);
    expect(canManageApiKeys("user", "")).toBe(false);
  });
});

describe("rate limiter helper", () => {
  it("limits when the binding says so", async () => {
    expect(await isRateLimited({ limit: async () => ({ success: false }) }, "k")).toBe(true);
    expect(await isRateLimited({ limit: async () => ({ success: true }) }, "k")).toBe(false);
  });
  it("allows when the binding is missing or broken (documented fail-open)", async () => {
    expect(await isRateLimited(undefined, "k")).toBe(false);
    expect(
      await isRateLimited({ limit: async () => { throw new Error("down"); } }, "k"),
    ).toBe(false);
  });
});
