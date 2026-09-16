/**
 * Canonical shape of the Identity & Access Review report's `summary` snapshot
 * (#5784 W06). Single-sourced: the API produces it with `satisfies`, the shared
 * PDF renderer and the web preview consume it, and it is persisted in
 * report_runs.result — so EVERY field is optional and a legacy snapshot must
 * still render. Mirrors hardwareLifecycleReport.ts.
 *
 * Nulls are load-bearing and there are three distinct ways to be unmeasured
 * here, each of which must read differently on the page:
 *   * mfaRegistered NULL  = UNKNOWN, never "not registered". m365_posture_rollups
 *     carries users_mfa_unknown / admins_mfa_unknown for exactly this reason.
 *   * risk fields 'hidden' = the tenant has no P2; render the section unmeasured,
 *     never "no risk detected".
 *   * signins.total null   = the tenant has no P1/P2, or Breeze has not synced
 *     this period; render a data-gap page, never an empty table.
 *
 * The event class is INTERACTIVE sign-ins only. Non-interactive,
 * service-principal and managed-identity sign-ins are not persisted by W05 and
 * must never be implied by this artifact.
 */

export type SigninCoverage = {
  /** Occurrence period (ISO dates), or the config date range for an ad-hoc run. */
  periodStart?: string;
  periodEnd?: string;
  /** What the events actually span. Breeze accumulates forward from first sync
   *  only and Graph keeps ~30 days, so the first monthly report is partial. */
  coveredFrom?: string | null;
  coveredTo?: string | null;
  generatedAt?: string;
  /** m365_sync_state.last_complete_snapshot_at for signin_events. NEVER
   *  last_success_at — a partial run succeeds without enumerating the tenant. */
  asOf?: string | null;
  lastStatus?: string | null;
  /** True when the tenant has no Entra ID P1/P2: permission was granted, the
   *  licence was not. A complete, zero-row success — NOT "no sign-ins". */
  unlicensed?: boolean;
  /**
   * True when sign-in events WERE held for the period but every risk value came
   * back as Graph's `hidden` sentinel — i.e. the tenant has no Entra ID P2.
   *
   * Load-bearing because `signins.byRiskLevel` is null for two different
   * reasons: this one, and "there were no sign-ins to assess". Rendering the
   * P2 sentence for the second would assert a licensing gap that may not exist,
   * on a customer-facing evidence document. Absent on a legacy snapshot, which
   * renders as the neutral line.
   */
  riskUnmeasured?: boolean;
  /** Any stretch inside the period with no events AND no successful sync —
   *  unrecoverable, because Graph's own retention has passed. */
  gapNote?: string | null;
  /** One human sentence naming every gap above. Rendered verbatim. */
  note?: string;
};

export type DormantAccountRow = {
  userPrincipalName: string | null;
  displayName: string | null;
  /** null means NEVER OBSERVED signing in, which is not the same as "long ago". */
  lastSuccessfulSignInAt: string | null;
  isAdmin: boolean;
  /** null = unknown, never false. */
  mfaRegistered: boolean | null;
};

export type AdminSigninRow = {
  signedInAt: string;
  userPrincipalName: string | null;
  appDisplayName: string | null;
  clientAppUsed: string | null;
  ipAddress: string | null;
  locationCity: string | null;
  locationCountry: string | null;
  conditionalAccessStatus: string | null;
  statusErrorCode: number | null;
  /** Graph's 'hidden' sentinel survives here verbatim; the renderer treats it as
   *  unmeasured rather than as a risk level. */
  riskLevelAggregated: string | null;
};

export type CaPolicyRow = {
  displayName: string | null;
  state: 'enabled' | 'enabledForReportingButNotEnforced' | 'disabled' | string | null;
  /** True when last_changed_at falls inside the period — a CA change nobody
   *  announced is the finding. */
  changedThisPeriod: boolean;
  /** True when the policy is gone from the tenant but still held by Breeze. */
  isStale: boolean;
};

export type IdentityAccessSummary = {
  orgId?: string;
  orgName?: string | null;
  generatedAt?: string;
  coverage?: SigninCoverage;
  identity?: {
    usersTotal: number | null;
    usersEnabled: number | null;
    usersDisabled: number | null;
    admins: number | null;
    mfaRegistered: number | null;
    /** Counted separately and NEVER folded into "not registered". */
    mfaUnknown: number | null;
    adminsWithoutMfa: number | null;
    adminsMfaUnknown: number | null;
  };
  dormant?: { thresholdDays?: number; rows: DormantAccountRow[] } | null;
  signins?: {
    total: number | null;
    distinctUsers: number | null;
    failures: number | null;
    failuresByErrorCode: Record<string, number> | null;
    /** null when homeCountries is empty — "not configured", NOT "none". */
    outsideHomeCountries: number | null;
    legacyAuth: Record<string, number> | null;
    conditionalAccessFailures: number | null;
    /** null when every risk value came back as Graph's 'hidden' sentinel. */
    byRiskLevel: Record<string, number> | null;
  };
  /** The section an auditor reads first. Omitted when config.adminDetail is off. */
  adminSignins?: AdminSigninRow[] | null;
  conditionalAccess?: { policies: CaPolicyRow[] | null; changedThisPeriod: number | null };
  /** Labelled CLIENT PRESENCE, not policy: devices.active_vpns records which
   *  overlay client is up, and the collector carries no peer lists, keys or
   *  policy (agent/internal/collectors/vpn.go:13-18). */
  remoteAccess?: { byProvider: Record<string, number> | null; caveat: string } | null;
  rows?: AdminSigninRow[];
  dataGaps?: string[];
};
