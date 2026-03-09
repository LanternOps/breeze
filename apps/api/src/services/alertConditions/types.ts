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
  value: number; // Mbps (converted to bps internally)
  durationMinutes?: number;
}

// Disk I/O high condition
export interface DiskIoHighCondition {
  type: 'disk_io_high';
  direction: 'read' | 'write' | 'total';
  operator: ComparisonOperator;
  value: number; // MB/s (converted to Bps internally)
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
  | CertExpiryCondition;

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
}
