/**
 * Canonical shape of the Endpoint Management Review report's `summary` snapshot
 * (#5784 W03). Single-sourced: the API produces it with `satisfies`, the shared
 * PDF renderer and the web preview consume it, and it is persisted in
 * report_runs.result — so EVERY field is optional and a legacy snapshot must
 * still render. Mirrors hardwareLifecycleReport.ts.
 *
 * Nulls are load-bearing. `intuneDevices: null` means UNMEASURED (the domain has
 * never completed a snapshot, or needs consent, or is throttled), never zero.
 * The rule the whole M365 posture program follows: m365_posture_rollups carries
 * `devices_unknown` for exactly this reason.
 */

/** Per-domain freshness, printed on the cover and machine-readable. */
export type EndpointFreshness = {
  /** m365_sync_state.last_complete_snapshot_at. NEVER last_success_at: a partial
   *  run succeeds without enumerating the tenant. */
  asOf?: string | null;
  lastStatus?: string | null;
  truncated?: boolean;
  /** Per-source outcome from m365_sync_state.sources, e.g. needs_consent. */
  sources?: Record<string, string> | null;
  /** True when asOf is older than the domain's sync cadence allows. Judged
   *  against the 6 h cadence, NOT against the reporting period. */
  stale?: boolean;
  /** One human sentence naming every gap. Rendered verbatim. */
  note?: string;
};

export type ComplianceState = 'compliant' | 'noncompliant' | 'inGracePeriod' | 'unknown';

/** The four buckets, in render order. Exported so the PDF renderer and the web
 *  preview cannot invent a fifth or reorder them independently. */
export const COMPLIANCE_STATES: readonly ComplianceState[] = [
  'compliant',
  'noncompliant',
  'inGracePeriod',
  'unknown',
];

export type IntuneDeviceRow = {
  id: string;
  deviceName: string | null;
  operatingSystem: string | null;
  osVersion: string | null;
  userPrincipalName: string | null;
  ownerType: string | null;
  lastIntuneSyncAt: string | null;
  complianceState: ComplianceState | null;
  jailBroken: string | null;
  /** True when the row is present in Breeze but gone from the tenant. */
  isStale?: boolean;
  /** Null when the Intune record has no breeze_device_id link. */
  breezeDeviceId?: string | null;
};

export type LicenceSeatRow = {
  skuPartNumber: string | null;
  consumedUnits: number | null;
  prepaidEnabled: number | null;
  prepaidWarning: number | null;
  prepaidSuspended: number | null;
  capabilityStatus: string | null;
};

export type ComplianceTrendPoint = {
  date: string;
  compliant: number | null;
  noncompliant: number | null;
  inGrace: number | null;
  unknown: number | null;
};

export type EndpointManagementSummary = {
  orgId?: string;
  orgName?: string | null;
  generatedAt?: string;
  /** Occurrence period, or the config date range for an ad-hoc run. */
  period?: { start?: string; end?: string };
  freshness?: Record<string, EndpointFreshness>;
  /** null = unmeasured. */
  enrolment?: {
    /** Devices the requesting authority can account for: the linked, in-scope
     *  population plus `intuneWithoutBreezeLink`. NOT the org-wide Intune row
     *  count — that would disclose the whole tenant's enrolment scale to a
     *  site-restricted technician. */
    intuneDevices: number | null;
    breezeDevices: number | null;
    breezeWithoutIntune: number | null;
    /** Disclosed as a COUNT ONLY under a restricted authority — never enumerated,
     *  since those devices sit outside the technician's sites. */
    intuneWithoutBreezeLink: number | null;
  };
  compliance?: {
    byState: Record<ComplianceState, number> | null;
    /** Daily series from m365_posture_rollups — the ONLY genuine history
     *  available. Entity columns cannot supply it (see the report's doc note). */
    trend?: ComplianceTrendPoint[];
  };
  staleEnrolments?: { count: number | null; thresholdDays?: number };
  licences?: LicenceSeatRow[] | null;
  rows?: IntuneDeviceRow[];
  dataGaps?: string[];
  /** Stated on the artifact so no reader infers device-level history exists. */
  historyCaveat?: string;
};
