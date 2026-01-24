// ============================================
// Filter System Types
// ============================================

/**
 * Operators for filter conditions
 */
export type FilterOperator =
  // Comparison operators
  | 'equals'
  | 'notEquals'
  | 'greaterThan'
  | 'greaterThanOrEquals'
  | 'lessThan'
  | 'lessThanOrEquals'
  // String operators
  | 'contains'
  | 'notContains'
  | 'startsWith'
  | 'endsWith'
  | 'matches' // regex
  // Collection operators
  | 'in'
  | 'notIn'
  | 'hasAny'
  | 'hasAll'
  | 'isEmpty'
  | 'isNotEmpty'
  // Null operators
  | 'isNull'
  | 'isNotNull'
  // Date operators
  | 'before'
  | 'after'
  | 'between'
  | 'withinLast' // e.g., within last 7 days
  | 'notWithinLast';

/**
 * Field categories for organizing filterable attributes
 */
export type FilterFieldCategory =
  | 'core'
  | 'os'
  | 'hardware'
  | 'network'
  | 'metrics'
  | 'software'
  | 'hierarchy'
  | 'custom'
  | 'computed';

/**
 * Field data types that determine available operators
 */
export type FilterFieldType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'array'
  | 'enum';

/**
 * Definition of a filterable field
 */
export interface FilterFieldDefinition {
  key: string;
  label: string;
  category: FilterFieldCategory;
  type: FilterFieldType;
  operators: FilterOperator[];
  enumValues?: string[];
  description?: string;
  computed?: boolean;
}

/**
 * A single filter condition
 */
export interface FilterCondition {
  field: string;
  operator: FilterOperator;
  value: FilterValue;
}

/**
 * Possible values for filter conditions
 */
export type FilterValue =
  | string
  | number
  | boolean
  | Date
  | string[]
  | number[]
  | { from: Date; to: Date } // for 'between' operator
  | { amount: number; unit: 'minutes' | 'hours' | 'days' | 'weeks' | 'months' }; // for 'withinLast'

/**
 * Group of conditions with AND/OR logic
 */
export interface FilterConditionGroup {
  operator: 'AND' | 'OR';
  conditions: (FilterCondition | FilterConditionGroup)[];
}

/**
 * Root filter object that can be either a single condition or a group
 */
export type FilterRoot = FilterCondition | FilterConditionGroup;

/**
 * Saved filter entity
 */
export interface SavedFilter {
  id: string;
  orgId: string;
  name: string;
  description: string | null;
  conditions: FilterConditionGroup;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Result of evaluating a filter
 */
export interface FilterEvaluationResult {
  deviceIds: string[];
  totalCount: number;
  evaluatedAt: Date;
}

/**
 * Filter preview result with device summaries
 */
export interface FilterPreviewResult {
  totalCount: number;
  devices: FilterPreviewDevice[];
  evaluatedAt: Date;
}

export interface FilterPreviewDevice {
  id: string;
  hostname: string;
  displayName: string | null;
  osType: string;
  status: string;
  lastSeenAt: Date | null;
}

// ============================================
// Custom Fields Types
// ============================================

/**
 * Custom field types
 */
export type CustomFieldType = 'text' | 'number' | 'boolean' | 'dropdown' | 'date';

/**
 * Custom field definition
 */
export interface CustomFieldDefinition {
  id: string;
  orgId: string | null; // null = global
  partnerId: string | null;
  name: string;
  fieldKey: string;
  type: CustomFieldType;
  options: CustomFieldOptions | null;
  required: boolean;
  defaultValue: unknown;
  deviceTypes: string[] | null; // null = all device types
  createdAt: Date;
  updatedAt: Date;
}

export interface CustomFieldOptions {
  // For dropdown type
  choices?: Array<{ label: string; value: string }>;
  // For number type
  min?: number;
  max?: number;
  // For text type
  minLength?: number;
  maxLength?: number;
  pattern?: string;
}

/**
 * Custom field value stored on device
 */
export type CustomFieldValues = Record<string, unknown>;

// ============================================
// Group Membership Types
// ============================================

/**
 * Extended device group with filter support
 */
export interface DeviceGroupWithFilter {
  id: string;
  orgId: string;
  siteId: string | null;
  name: string;
  type: 'static' | 'dynamic';
  filterConditions: FilterConditionGroup | null;
  filterFieldsUsed: string[];
  parentId: string | null;
  deviceCount: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Group membership with pinning support
 */
export interface DeviceGroupMembershipExtended {
  deviceId: string;
  groupId: string;
  isPinned: boolean;
  addedAt: Date;
  addedBy: 'manual' | 'dynamic_rule' | 'policy';
}

/**
 * Audit log entry for group membership changes
 */
export interface GroupMembershipLogEntry {
  id: string;
  groupId: string;
  deviceId: string;
  action: 'added' | 'removed';
  reason: 'manual' | 'filter_match' | 'filter_unmatch' | 'pinned' | 'unpinned';
  createdAt: Date;
}

// ============================================
// Deployment Types
// ============================================

export type DeploymentType = 'script' | 'patch' | 'software' | 'policy';

export type DeploymentStatus =
  | 'draft'
  | 'scheduled'
  | 'running'
  | 'paused'
  | 'completed'
  | 'cancelled'
  | 'failed';

export type DeploymentDeviceStatus =
  | 'pending'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'retrying';

export type DeploymentTargetType = 'devices' | 'groups' | 'filter' | 'all';

/**
 * Rollout configuration for deployments
 */
export interface RolloutConfig {
  type: 'immediate' | 'staggered';
  staggered?: {
    batchSize: number | string; // 10 or "10%"
    batchDelayMinutes: number;
    pauseOnFailureCount?: number;
    pauseOnFailurePercent?: number;
  };
  respectMaintenanceWindows: boolean;
  retryConfig: {
    maxRetries: number;
    backoffMinutes: number[]; // e.g., [5, 15, 60]
  };
}

/**
 * Deployment target configuration
 */
export interface DeploymentTargetConfig {
  type: DeploymentTargetType;
  deviceIds?: string[];
  groupIds?: string[];
  filter?: FilterConditionGroup;
}

/**
 * Deployment schedule configuration
 */
export interface DeploymentSchedule {
  type: 'immediate' | 'scheduled' | 'maintenance_window';
  scheduledAt?: Date;
  maintenanceWindowId?: string;
}

/**
 * Main deployment entity
 */
export interface Deployment {
  id: string;
  orgId: string;
  name: string;
  type: DeploymentType;
  payload: DeploymentPayload;
  targetType: DeploymentTargetType;
  targetConfig: DeploymentTargetConfig;
  schedule: DeploymentSchedule | null;
  rolloutConfig: RolloutConfig;
  status: DeploymentStatus;
  createdBy: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

/**
 * Payload varies by deployment type
 */
export type DeploymentPayload =
  | { type: 'script'; scriptId: string; parameters?: Record<string, unknown> }
  | { type: 'patch'; patchIds: string[] }
  | { type: 'software'; packageId: string; action: 'install' | 'uninstall' | 'update' }
  | { type: 'policy'; policyId: string };

/**
 * Individual device in a deployment
 */
export interface DeploymentDevice {
  id: string;
  deploymentId: string;
  deviceId: string;
  batchNumber: number | null;
  status: DeploymentDeviceStatus;
  retryCount: number;
  maxRetries: number;
  startedAt: Date | null;
  completedAt: Date | null;
  result: DeploymentDeviceResult | null;
}

export interface DeploymentDeviceResult {
  success: boolean;
  exitCode?: number;
  output?: string;
  error?: string;
  durationMs?: number;
}

/**
 * Deployment progress summary
 */
export interface DeploymentProgress {
  total: number;
  pending: number;
  running: number;
  completed: number;
  failed: number;
  skipped: number;
  currentBatch: number | null;
  totalBatches: number | null;
  percentComplete: number;
}

// ============================================
// Maintenance Window Types (Extended)
// ============================================

export type MaintenanceWindowBehavior = 'required' | 'preferred' | 'ignore';

export interface MaintenanceTimeSlot {
  dayOfWeek: 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0 = Sunday
  startTime: string; // HH:MM format
  endTime: string; // HH:MM format
}

export interface MaintenanceWindowConfig {
  slots: MaintenanceTimeSlot[];
  timezone: string;
  behavior: MaintenanceWindowBehavior;
}
