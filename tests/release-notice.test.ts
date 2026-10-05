import { describe, expect, it } from "vitest";
import { isExpired } from "@/components/release-notice";

describe("release expiry", () => {
  const own = "a".repeat(40);
  it("is expired only when valid shared metadata no longer lists this release", () => {
    expect(isExpired(own, { schema: 2, releases: ["b".repeat(40)] })).toBe(true);
    expect(isExpired(own, { schema: 2, releases: ["b".repeat(40), own] })).toBe(false);
    expect(isExpired(own, { schema: 1, releases: ["b".repeat(40)] })).toBe(false);
    expect(isExpired(own, { schema: 2, releases: [] })).toBe(false);
    expect(isExpired(own, { schema: 2, releases: ["../x"] })).toBe(false);
    expect(isExpired(own, "nope")).toBe(false);
  });
});
