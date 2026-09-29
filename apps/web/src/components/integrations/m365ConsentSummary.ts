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

export type M365ConsentStepSummary = {
  loadState: M365ConsentLoadState;
  onboardingEnabled: boolean;
  connection: M365ConsentConnectionSummary | null;
};

export type M365LegacyStatus = "loading" | "connected" | "disconnected" | "not-enabled" | "error";

/** A consent connection Breeze can currently use (not pending, suspended or revoked). */
export function isUsableConsentConnection(
  connection: M365ConsentConnectionSummary | null | undefined,
): boolean {
  return connection?.status === "active" || connection?.status === "degraded";
}
