// What a consent step (Customer Graph Read / Actions) reports to the
// Microsoft 365 tenant section so the section can decide the sub-tab's layout
// and show the tenant identity once, in the panel header. The steps keep
// owning their own fetch and state machines; this is a read-only projection.

export type M365ConsentLoadState = "unavailable" | "loading" | "ready" | "error";

export type M365ConsentConnectionSummary = {
  tenantId: string | null;
  displayName: string | null;
  lastVerifiedAt: string | null;
  status: string;
};

/** Which switch gates consent onboarding (#9319). Mirrors the API status payload. */
export type M365OnboardingAvailability = "enabled" | "instance_disabled" | "org_not_enabled";

/**
 * Reads the status payload's `onboardingAvailability`. Absent (an API that
 * predates the field) falls back to what `onboardingEnabled` implies; an
 * unknown value is rejected (null) so the strict envelope parsers fail closed.
 */
export function parseOnboardingAvailability(
  value: unknown,
  onboardingEnabled: boolean,
): M365OnboardingAvailability | null {
  if (value === undefined) return onboardingEnabled ? "enabled" : "instance_disabled";
  if (value !== "enabled" && value !== "instance_disabled" && value !== "org_not_enabled") return null;
  // The two fields describe the same gate; a disagreeing payload is malformed.
  if ((value === "enabled") !== onboardingEnabled) return null;
  return value;
}

export type M365ConsentStepSummary = {
  loadState: M365ConsentLoadState;
  onboardingEnabled: boolean;
  onboardingAvailability: M365OnboardingAvailability;
  connection: M365ConsentConnectionSummary | null;
};

export type M365LegacyStatus = "loading" | "connected" | "disconnected" | "not-enabled" | "error";

/** A consent connection Breeze can currently use (not pending, suspended or revoked). */
export function isUsableConsentConnection(
  connection: M365ConsentConnectionSummary | null | undefined,
): boolean {
  return connection?.status === "active" || connection?.status === "degraded";
}
