import type { DeviceFunctionKey } from '../validators/deviceFunctions';

export const FLEET_DESIGN_SCHEMA_VERSION = 1 as const;

export const FLEET_DESIGN_SECTION_KEYS = [
  'found', 'functions', 'monitoring', 'retired', 'automation', 'legacy', 'baseline', 'unsure',
] as const;
export type FleetDesignSectionKey = (typeof FLEET_DESIGN_SECTION_KEYS)[number];

export const FLEET_DESIGN_SECTION_TITLES: Readonly<Record<FleetDesignSectionKey, string>> = Object.freeze({
  found: 'What was found', functions: 'What each device is for', monitoring: 'What to watch, and why',
  retired: 'What is not carried forward', automation: 'Automation', legacy: 'Legacy script inventory',
  baseline: 'Baseline and precursors', unsure: 'What the designer is unsure about',
});

export const FLEET_DESIGN_CONFIDENCE_THRESHOLD = 0.6;
export const FLEET_DESIGN_PRECURSOR_THRESHOLDS = Object.freeze({
  diskUsedPercent: 80, rebootPendingDays: 7, patchAgeDays: 30, certificateDays: 30, serviceRestartsPer30d: 2,
});
export type FleetDesignThresholds = { confidence: number; precursors: typeof FLEET_DESIGN_PRECURSOR_THRESHOLDS };

export const FLEET_DESIGN_TEXT_MAX_CHARS = 400;
export const FLEET_DESIGN_LIST_MAX = 200;
export const FLEET_DESIGN_DEVICE_IDS_MAX = 2000;

export type FleetDesignPrecursorCondition =
  | 'disk_used_over_threshold' | 'reboot_pending_over_threshold' | 'patch_age_over_threshold'
  | 'certificate_expiring' | 'backup_missed' | 'service_restarted_over_threshold';

export interface FleetDesignBaselineNumbers {
  alertsPer100EndpointsPerMonth: number | null;
  ticketsPerMonth: number | null;
  precursors: { condition: FleetDesignPrecursorCondition; deviceCount: number | null }[];
}

export interface FleetDesignFunctionEntry {
  functionKey: DeviceFunctionKey | `custom:${string}`;
  label?: string;
  deviceIds: string[];
  confidence: number;
  evidence: string[];
  /** Server-assigned: `functions:<functionKey>`. */
  itemRef?: string;
}
export interface FleetDesignWatch {
  watchType: 'service' | 'process';
  name: string;
  alertOnStop: boolean;
  autoRestart: boolean;
  rationale: string;
  itemRef?: string;
}
export interface FleetDesignRule {
  name: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  conditions: unknown[];          // alertRuleConditionSchema items; typed loosely here, validated in the validator
  cooldownMinutes: number;
  rationale: string;
  action: 'none' | { kind: 'playbook'; ref: string } | { kind: 'script'; ref: string };
  paging: 'none' | 'business_hours' | 'always';
  sourceTemplateId?: string;
  itemRef?: string;
}
export interface FleetDesignMonitoringEntry { functionKey: string; watches: FleetDesignWatch[]; alertRules: FleetDesignRule[] }
export interface FleetDesignRetiredItem {
  kind: 'watch' | 'rule';
  policyId: string;
  policyName: string;
  itemName: string;
  reason: string;
  itemRef?: string;
}
export interface FleetDesignAutomationEntry {
  functionKey: string;
  playbooks: ({ builtInName: string } | { custom: { name: string; description: string; steps: string[]; triggeredBy: string } })[];
  scripts: { name: string; purpose: string; osTypes: ('windows' | 'macos' | 'linux')[]; language: 'powershell' | 'bash' | 'python' | 'cmd'; content: string; itemRef?: string }[];
}
export interface FleetDesignLegacyItem {
  scriptId: string;
  scriptName: string;
  intent: string;
  bucket: 'obsolete' | 'covered' | 'needed';
  coveredBy?: string;
  notes: string;
  itemRef?: string;
}
export interface FleetDesignRoleCorrection {
  deviceId: string;
  currentRole: string;
  proposedRole: string;
  evidence: string[];
  billingRelevant: true;
  itemRef?: string;
}

/** What the model submits through `submit_fleet_design`. */
export interface FleetDesignSubmission {
  found: { summary: string[]; findings: { title: string; deviceCount: number; evidence: string[] }[] };
  functions: FleetDesignFunctionEntry[];
  monitoring: FleetDesignMonitoringEntry[];
  retired: FleetDesignRetiredItem[];
  automation: FleetDesignAutomationEntry[];
  legacy: FleetDesignLegacyItem[];
  baseline: { notes: string[] };
  unsure: {
    lowConfidenceFunctions: FleetDesignFunctionEntry[];
    unreachableDevices: string[];
    needsHuman: string[];
    roleCorrections: FleetDesignRoleCorrection[];
  };
}

/** Server-built from a validated submission — what the run stores and the report renders. */
export interface FleetDesignOutcome {
  schemaVersion: typeof FLEET_DESIGN_SCHEMA_VERSION;
  sections: Omit<FleetDesignSubmission, 'baseline'> & { baseline: { notes: string[]; numbers: FleetDesignBaselineNumbers } };
  thresholds: FleetDesignThresholds;
  generatedAt: string;
  markdown: string;
}

export type FleetDesignDriftKind = 'watch' | 'rule' | 'assignment' | 'group_member';

/**
 * W05 (#5655): how the live fleet has moved away from the approved (applied)
 * design, computed server-side by `services/fleetDesign/drift.ts` on a design
 * run that follows an applied one. `missing` = approved and gone; `extra` =
 * live and not carried by the design; `changed` = approved but edited.
 */
export interface FleetDesignDrift {
  approvedReportRunId: string;
  appliedAt: string;
  missing: { functionKey: string; kind: FleetDesignDriftKind; name: string }[];
  extra: { policyId: string; policyName: string; kind: 'watch' | 'rule'; name: string; deviceCount: number }[];
  changed: { functionKey: string; kind: 'watch' | 'rule'; name: string; field: string; approved: string; live: string }[];
}

/** `report_runs.result.summary.fleetDesign`. Every field optional (persisted jsonb, old snapshots must render). */
export interface FleetDesignReportSummary {
  fleetDesign?: {
    schemaVersion?: number;
    outcome?: FleetDesignOutcome;
    orgName?: string;
    partnerName?: string;
    siteName?: string | null;
    generatedAt?: string;
    runId?: string;
    agentName?: string;
    evidenceTruncated?: boolean;
    devicesNotAssessed?: number;
    /** Evidence sections whose loader failed — their numbers were never measured (never invented zeros). */
    unavailable?: string[];
    /** W05: set only when an applied design existed for the org when this run started; null/absent otherwise. */
    drift?: FleetDesignDrift | null;
  };
}

/** Safe projection for `GET /ai/agents/runs/:runId` and the Fleet Design page. */
export interface AiAgentRunFleetDesignDto {
  reportRunId: string | null;
  reportId: string | null;
  downloadPath: string | null;
  generatedAt: string | null;
  functionCount: number;
  watchCount: number;
  ruleCount: number;
  evidenceTruncated: boolean;
}

/**
 * `GET /ai/fleet-design/designer` (#6214) — whether the org can run a Fleet
 * Design right now, and if not, why and whether the caller can fix it with
 * one click (`POST /ai/fleet-design/designer/enable`).
 *
 * - `missing`: no partner-wide designer agent exists (an org row alone can
 *   never self-enable — `resolveEffectiveAgent` needs the partner baseline).
 * - `disabled` / `off`: an agent resolves but its effective `enabled` is
 *   false / its effective mode is `off`.
 * - `kill_switch_off`: `BREEZE_AI_AGENTS_ENABLED` is off platform-wide;
 *   nothing on a tenant can change that, so `canEnable` is always false.
 */
export type FleetDesignerSetupStatus = 'ready' | 'missing' | 'off' | 'disabled' | 'kill_switch_off';

export interface FleetDesignerSetup {
  status: FleetDesignerSetupStatus;
  /** The partner baseline row's id when one resolves, else null. */
  agentId: string | null;
  /** Whether the enable endpoint would succeed for THIS caller — false for
   *  an org-scoped token when the fix needs a partner-wide write. */
  canEnable: boolean;
}
