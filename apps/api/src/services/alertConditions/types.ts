/**
 * Alert Condition Types
 *
 * All interfaces for condition evaluation, shared across handlers.
 */

// Supported comparison operators
export type ComparisonOperator = 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq';

// Metric types that can be monitored (names match Drizzle ORM property names on deviceMetrics)
export type MetricName = 'cpuPercent' | 'ramPercent' | 'diskPercent' | 'processCount';

// Single threshold condition (also accepts type: 'metric' for backwards compatibility)
export interface ThresholdCondition {
  type: 'threshold' | 'metric';
  metric: string;
  operator: ComparisonOperator;
  value: number;
  durationMinutes?: number;
}

// Offline detection condition
export interface OfflineCondition {
  type: 'offline';
  durationMinutes?: number;
}

// Event log condition
export interface EventLogCondition {
  type: 'event_log';
  category: 'security' | 'hardware' | 'application' | 'system';
  level: 'warning' | 'error' | 'critical';
  sourcePattern?: string;
  messagePattern?: string;
  countThreshold: number;
  windowMinutes: number;
}

// Service stopped condition
export interface ServiceCondition {
  type: 'service_stopped';
  serviceName: string;
  consecutiveFailures?: number;
}

// Process stopped condition
export interface ProcessCondition {
  type: 'process_stopped';
  processName: string;
  consecutiveFailures?: number;
}

// Process resource (CPU/memory) condition
export interface ProcessResourceCondition {
  type: 'process_cpu_high' | 'process_memory_high';
  processName: string;
  operator: ComparisonOperator;
  value: number;
  durationMinutes?: number;
}

// Bandwidth high condition
export interface BandwidthHighCondition {
  type: 'bandwidth_high';
  direction: 'in' | 'out' | 'total';
  operator: ComparisonOperator;
  value: number; // megaBITS/sec; agent samples are bytes/sec, handler converts (x8)
  durationMinutes?: number;
}

// Disk I/O high condition
export interface DiskIoHighCondition {
  type: 'disk_io_high';
  direction: 'read' | 'write' | 'total';
  operator: ComparisonOperator;
  value: number; // MB/s (10^6 bytes/sec); agent samples are bytes/sec
  durationMinutes?: number;
}

// Network errors condition
export interface NetworkErrorsCondition {
  type: 'network_errors';
  interfaceName?: string;
  errorType: 'in' | 'out' | 'total';
  operator: ComparisonOperator;
  value: number;
  windowMinutes?: number;
}

// Patch compliance condition
export interface PatchComplianceCondition {
  type: 'patch_compliance';
  operator: ComparisonOperator;
  value: number; // e.g. 80 for 80%
}

// Certificate expiry condition
export interface CertExpiryCondition {
  type: 'cert_expiry';
  withinDays: number;
}

// --- W04 coverage kinds (#5287 / #5291) ----------------------------------

// Antivirus posture condition. `realTimeProtection` and `definitionsDate` are
// three-valued in `security_status`; the handler treats NULL as "no data",
// never as the bad state.
export interface AntivirusCondition {
  type: 'antivirus';
  check: 'not_protected' | 'definitions_stale' | 'realtime_disabled' | 'threats_present';
  staleAfterDays?: number;
  minThreatCount?: number;
}

// Installed-software presence condition. `presence: 'installed'` BREACHES when
// the software IS installed ("alert me that this is present").
export interface SoftwarePresenceCondition {
  type: 'software_presence';
  name: string;
  vendor?: string;
  presence: 'installed' | 'not_installed' | 'version_below';
  version?: string;
}

// Backup continuity condition, evaluated over `backup_jobs` (never over the
// SLA worker's own state, which runs on its own cadence).
export interface BackupContinuityCondition {
  type: 'backup_continuity';
  check: 'no_successful_backup' | 'consecutive_failures';
  maxAgeHours?: number;
  failureCount?: number;
}

// Script monitor condition. `monitorId` is the MONITOR DEFINITION's id: the
// handler's evidence is a `script_executions` row stamped with it, which is
// what separates a monitor's own probe from any other run of the same script.
export interface ScriptMonitorCondition {
  type: 'script_monitor';
  monitorId: string;
  intervalMinutes: number;
  breachOnNonZeroExit: boolean;
}

// Network check condition. `monitorId` is the MONITOR DEFINITION's id, not the
// managed network_monitors row's — the managed row is found through
// `managed_by_monitor_id`, so the condition survives a re-provision.
export interface NetworkCheckCondition {
  type: 'network_check';
  monitorId: string;
  consecutiveFailures?: number;
  /** A degraded result counts as a failure (legacy degraded rule). */
  degradedIsFailure?: boolean;
  /** A response slower than this counts as a failure (legacy response_time_gt). */
  maxResponseMs?: number;
}

// --- W03 (hardware & RAID monitoring) -------------------------------------

// `HardwareComponentType` from `@breeze/shared` minus 'bmc' — BMC health is a
// separate, future, out-of-band spec (see the design doc).
import type { HardwareComponentType } from '@breeze/shared';
export type HardwareHealthComponentFilter = Exclude<HardwareComponentType, 'bmc'>;

// Per-subject (per-component) evidence a leaf handler can report, alongside
// or instead of a single scalar `ConditionResult`. `unknown` means observed
// but not yet resolvable to breaching/recovered (e.g. missing prior snapshot).
export type SubjectStatus = 'breaching' | 'recovered' | 'unknown';
export interface SubjectEvidence {
  subjectKey: string;
  status: SubjectStatus;
  description: string;
  actualValue?: number;
  context?: Record<string, unknown>;
}

// Hardware health condition. Root-only (see `compositeChildSchema` in
// `@breeze/shared` monitors.ts) — evaluates fresh component evidence rather
// than a single device-level scalar.
export interface HardwareHealthCondition {
  type: 'hardware_health';
  componentTypes: HardwareHealthComponentFilter[];
  minHealth: 'warning' | 'critical';
  includePredictiveFailure: boolean;
  consecutiveSnapshots: number;
}

// Union of all condition types
export type AlertCondition =
  | ThresholdCondition
  | OfflineCondition
  | EventLogCondition
  | ServiceCondition
  | ProcessCondition
  | ProcessResourceCondition
  | BandwidthHighCondition
  | DiskIoHighCondition
  | NetworkErrorsCondition
  | PatchComplianceCondition
  | CertExpiryCondition
  | AntivirusCondition
  | SoftwarePresenceCondition
  | BackupContinuityCondition
  | ScriptMonitorCondition
  | NetworkCheckCondition
  | HardwareHealthCondition;

// Compound condition with AND/OR logic
export interface ConditionGroup {
  logic: 'and' | 'or';
  conditions: (AlertCondition | ConditionGroup)[];
}

// Root condition can be a single condition or a group
export type RootCondition = AlertCondition | ConditionGroup;

// Evaluation result with context
export interface EvaluationResult {
  triggered: boolean;
  conditionsMet: string[];
  conditionsNotMet: string[];
  /** #5290 — 'unknown' when ANY evaluated leaf reported dataAvailable === false. */
  dataState: 'ok' | 'unknown';
  /** W03 — present when the leaf handler reported per-subject evidence. */
  subjects?: SubjectEvidence[];
  context: {
    metric?: string;
    actualValue?: number;
    threshold?: number;
    operator?: string;
    durationMinutes?: number;
    deviceId: string;
    evaluatedAt: string;
  };
}

// Result from a single condition handler
export interface ConditionResult {
  passed: boolean;
  description: string;
  actualValue?: number;
  /**
   * #5290 — false when the handler could not observe the device at all (no
   * samples in the window, no inventory row, agent never reported). ABSENT
   * MEANS TRUE: a handler that does not opt in keeps today's semantics.
   * Never conflate this with `passed: false`, which means "observed, healthy".
   */
  dataAvailable?: boolean;
  /** W03 — present when the handler reports per-subject (per-component) evidence. */
  subjects?: SubjectEvidence[];
}
