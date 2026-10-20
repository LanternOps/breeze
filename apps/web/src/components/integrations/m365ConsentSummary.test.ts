import { describe, expect, it } from "vitest";
import { parseOnboardingAvailability } from "./m365ConsentSummary";

describe("parseOnboardingAvailability (#9319)", () => {
  it("falls back to what onboardingEnabled implies when the API omits the field", () => {
    expect(parseOnboardingAvailability(undefined, true)).toBe("enabled");
    expect(parseOnboardingAvailability(undefined, false)).toBe("instance_disabled");
  });

  it("accepts each reason consistent with onboardingEnabled", () => {
    expect(parseOnboardingAvailability("enabled", true)).toBe("enabled");
    expect(parseOnboardingAvailability("instance_disabled", false)).toBe("instance_disabled");
    expect(parseOnboardingAvailability("org_not_enabled", false)).toBe("org_not_enabled");
  });

  it("rejects unknown values, null, and fields that disagree with onboardingEnabled", () => {
    expect(parseOnboardingAvailability("bogus", false)).toBeNull();
    expect(parseOnboardingAvailability(null, false)).toBeNull();
    expect(parseOnboardingAvailability("enabled", false)).toBeNull();
    expect(parseOnboardingAvailability("org_not_enabled", true)).toBeNull();
  });
});
