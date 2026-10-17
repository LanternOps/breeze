export const TRUST_FRAMEWORKS = ['cis_v8', 'essential_eight', 'cyber_essentials', 'nist_csf_2'] as const;
export type TrustFramework = (typeof TRUST_FRAMEWORKS)[number];
export interface FrameworkRef { framework: TrustFramework; ref: string }

export const TRUST_CONTROL_CATEGORY_ORDER = [
  'endpoint_protection', 'patching_hardening', 'identity_access', 'data_protection', 'monitoring', 'governance',
] as const;
export type TrustControlCategory = (typeof TRUST_CONTROL_CATEGORY_ORDER)[number];

/**
 * The 15 telemetry controls W1 shipped, frozen. A trust page published under W1 has a `published_config`
 * with no `catalogControlIds`; its refresh keeps exactly these (spec §19 item 28) so the page gains no
 * control until it is republished. Never edit this list.
 */
export const W1_TELEMETRY_CONTROL_IDS = Object.freeze([
  'endpoint_protection', 'edr_coverage', 'definitions_current', 'host_firewall',
  'os_patch_currency', 'hardening_baseline',
  'password_policy', 'least_privilege', 'identity_provider', 'mfa_registered_m365', 'privileged_access',
  'disk_encryption', 'backups_verified',
  'dns_filtering', 'continuous_monitoring',
] as const);

export const TELEMETRY_CONTROL_IDS = [
  'endpoint_protection', 'edr_coverage', 'definitions_current', 'host_firewall',
  'os_patch_currency', 'hardening_baseline',
  'password_policy', 'least_privilege', 'identity_provider', 'mfa_registered_m365', 'privileged_access',
  'disk_encryption', 'backups_verified',
  'dns_filtering', 'continuous_monitoring',
  'mfa_enforced_m365',
] as const;
export type TelemetryControlId = (typeof TELEMETRY_CONTROL_IDS)[number];

/** coverage_pct: passing/assessed, higher is better. exposure_pct: (assessed-passing)/assessed, lower is better.
 *  boolean: one org-level fact. pass_rate: `aggregatePct` (mean per-device pass rate), higher is better. */
export type TrustControlMetric = 'coverage_pct' | 'exposure_pct' | 'boolean' | 'pass_rate';
export type TrustControlUnit = 'devices' | 'users' | 'org';
export type TrustControlStatus = 'met' | 'attention' | 'not_met' | 'not_assessed';
export type TrustNotAssessedReason = 'insufficient_telemetry' | 'no_data' | 'not_applicable';

export interface TrustControlDefinition {
  id: TelemetryControlId;
  category: TrustControlCategory;
  /** English copy — the W1 source of truth for the public page and the editor (spec §19.4). */
  title: string;
  description: string;
  source: 'telemetry';
  metric: TrustControlMetric;
  unit: TrustControlUnit;
  /** 1 = asked first on insurer questionnaires. Unique. */
  insurerRank: number;
  frameworkRefs: readonly FrameworkRef[];
  /** When set, `met` additionally requires `evidence.gate === true`. */
  gate?: { label: string };
}

/** Counts, never percentages: the evaluator owns the denominator rule (spec §5.4). */
export interface ControlEvidence {
  eligible: number;
  assessed: number;
  /** Units meeting the control among `assessed` (for exposure metrics: units WITHIN the limit). */
  passing: number;
  /** pass_rate metrics only: mean per-device pass rate 0–100. */
  aggregatePct: number | null;
  /** ISO timestamp of the newest evidence among assessed units; null when none. */
  newestEvidenceAt: string | null;
  /** Secondary gate (MFA: admins_without_mfa === 0). Undefined when the control has no gate. */
  gate?: boolean | null;
}
export type PostureControlEvidence = Record<TelemetryControlId, ControlEvidence>;

export interface TrustEvaluationPolicy {
  coverageFloorPct: number;       // 80
  thresholds: { met: number; attention: number }; // 95 / 80
  evidenceMaxAgeDays: number;     // 30
}

export interface TrustControlAssessment {
  id: TelemetryControlId;
  category: TrustControlCategory;
  source: 'telemetry';
  unit: TrustControlUnit;
  status: TrustControlStatus;
  reason: TrustNotAssessedReason | null;
  /** coverage/pass_rate: passing %. exposure: exposure %. boolean: null. Null when not_assessed. */
  percent: number | null;
  assessed: number;
  eligible: number;
  evidenceAsOf: string | null;
  frameworkRefs: readonly FrameworkRef[];
}
