import type { AlertSeverity, MonitorKind } from '@breeze/shared';
import type { MonitorConversionSourceTable, MonitorConversionOutputRole } from '../../../db/schema/monitorConversions';

export type ConversionSourceTable = MonitorConversionSourceTable; // 'config_policy_alert_rules' | 'config_policy_monitoring_watches' | 'alert_templates' | 'automations' | 'config_policy_automations' | 'network_monitors'
export type ConversionOutputRole = MonitorConversionOutputRole;   // 'primary' | 'resource_cpu' | 'resource_memory' | 'response'

export interface ProposedMonitor {
  role: ConversionOutputRole;
  kind: MonitorKind;
  enabled: boolean;
  name: string;
  condition: Record<string, unknown>;
  severity: AlertSeverity;
  deliveryMode: 'inherit' | 'channels' | 'none';
  deliveryChannelIds: string[];
  escalationPolicyId: string | null;
  responses: unknown[];
  // Additive to the brief (needed to create the row; W05c2 may ignore them):
  cooldownMinutes: number;
  autoResolve: boolean;
  description?: string;
}

export interface ConversionPreviewItem {
  sourceTable: ConversionSourceTable;
  sourceId: string;
  name: string;
  outcome: 'convertible' | 'unconvertible';
  /** `unconvertible:<code>` — the exact string stored in `retired_reason` on Retire. */
  reason?: string;
  proposed: ProposedMonitor[];
  responseTargetSourceId?: string;
  responseActions?: unknown[];
  workflow?: { policyId: string; sourceId: string; name: string; enabled: boolean; actions: unknown[]; onFailure: 'stop'|'continue'|'notify' };
  /** Human-readable facts the panel prints under the row (behaviour changes, dropped fields). */
  notes: string[];
  /** Open (active | acknowledged | suppressed) alerts the conversion will carry over. */
  openAlerts: number;
}

export interface EquivalenceDelta { deviceId: string; detail: string }

export interface PolicyConversionPreview {
  policyId: string;
  previewHash: string;
  items: ConversionPreviewItem[];
  inheritanceMode: 'cumulative' | 'replace';
  equivalence: { devicesChecked: number; deltas: EquivalenceDelta[] };
  blockedBy?: 'parent_unconverted' | 'prerequisite_missing';
  /** Set with blockedBy = 'prerequisite_missing': the labels of the fixes that are absent. */
  missingPrerequisites?: string[];
}

/** Returned by GET …/preview while the >500-device equivalence job runs (HTTP 202). */
export interface PolicyConversionPreviewPending {
  status: 'running';
  progress: { checked: number; total: number };
}

/**
 * Returned by GET …/preview once the background job has failed
 * MAX_PREVIEW_ATTEMPTS times for the same scope and sources. Without this a
 * deterministically failing preview polls as `running` for ever, with progress
 * resetting to 0 on every call and no way for the caller to learn it is broken.
 * The reason is a fixed code: the underlying error is scrubbed from the cache
 * and reaches Sentry instead.
 */
export interface PolicyConversionPreviewFailed {
  status: 'failed';
  error: 'preview_failed';
}

export interface ConvertPolicyResult { conversionIds: string[]; retired: number; monitorsCreated: number }
export interface ConvertPartnerResult { policies: number; converted: number; unconvertible: number }
export interface PendingConversionCounts { policies: number; rows: number }
export interface PartnerConversionPreview {
  partnerId: string; previewHash: string; policies: number; rows: number; convertible: number;
  unconvertible: Array<{ policyId: string | null; policyName: string | null;
    sourceTable: ConversionSourceTable; sourceId: string; name: string; reason: string }>;
}
export interface ConversionLedgerEntry {
  id: string; sourceTable: ConversionSourceTable; sourceId: string; sourceName: string;
  policyId: string | null; convertedBy: string | null; convertedAt: string;
  revertedAt: string | null; revertable: boolean;
  outputs: Array<{ monitorId: string; role: string; reused: boolean }>;
}


export const RETIRED_REASON = {
  operator: 'operator',
  unconvertible: (code: string) => `unconvertible:${code}` as const,
} as const;

export const EQUIVALENCE_JOB_THRESHOLD = 500;
