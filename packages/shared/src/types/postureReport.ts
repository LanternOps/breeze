/**
 * Canonical shape of the Security & Compliance Posture report's `summary`
 * snapshot. Single-sourced here because it crosses the API→web package boundary
 * AND is persisted (report_runs.result), so future web code renders old snapshots.
 *
 * The API generator builds the summary with `satisfies PostureSummary` so a
 * renamed/retyped field is a compile error at the producer; the web PDF renderer
 * imports this same type. Fields are optional because a persisted legacy/partial
 * snapshot must still render — the renderer guards every access defensively.
 *
 * Percentage fields are `number | null`: null means "not assessed" (rendered as
 * "N/A", never a misleading 0%). Each control with a *Unknown count surfaces how
 * many in-scope devices lacked the data for that control.
 */

export type PostureProductCategory =
  | 'antivirus'
  | 'edr'
  | 'mdr'
  | 'dns_filtering'
  | 'backup'
  | 'identity';

export type PostureProduct = {
  product: string;
  category: PostureProductCategory;
  active: boolean;
  lastSyncStatus?: string | null;
  deviceCoverage?: number | null;
};

export type PostureControls = {
  edrCoveragePct?: number | null;
  anyAvCoveragePct?: number | null;
  unprotectedCount?: number;
  avDefinitionsCurrentPct?: number | null;
  encryptionPct?: number | null;
  firewallPct?: number | null;
  patchCurrentPct?: number | null;
  patchUnknownCount?: number;
  passwordComplexityPct?: number | null;
  passwordUnknownCount?: number;
  localAdminExposurePct?: number | null;
  localAdminUnknownCount?: number;
  cisAvgPassRate?: number | null;
  cisIncluded?: boolean;
  cisAssessedCount?: number;
  /** Proves an identity provider is CONNECTED, not that MFA is enforced. */
  identityProviderConnected?: boolean;
  backupRequired?: boolean;
  backupConfigured?: boolean;
  backupEncrypted?: boolean | null;
  dnsFilteringActive?: boolean;
  dnsFilteringSyncStatus?: string | null;
};

export type PosturePrivilegedAccess = {
  uacInterceptionEnabled?: boolean;
  activePamRules?: number;
  /** Length of the elevation-activity window in days (report config; default 30). */
  windowDays?: number;
  elevationsInWindow?: number;
  elevationsApproved?: number;
  elevationsDenied?: number;
  /** The real MFA-enforcement signal (authenticator_policies), distinct from identityProviderConnected. */
  mfaStepUpEnforced?: boolean;
};

export type PostureSummary = {
  org?: { id?: string; name?: string };
  generatedAt?: string;
  deviceCount?: number;
  controls?: PostureControls;
  privilegedAccess?: PosturePrivilegedAccess;
  securityProducts?: PostureProduct[];
  postureScore?: number | null;
};
