// ============================================
// Auth Types
// ============================================

export * from './auth';

// ============================================
// Multi-Tenancy Types
// ============================================

export type PartnerType = 'msp' | 'enterprise' | 'internal';
export type PlanType = 'free' | 'pro' | 'enterprise' | 'unlimited';
export type OrgType = 'customer' | 'internal';
export type OrgStatus = 'active' | 'suspended' | 'trial' | 'churned';

export interface Partner {
  id: string;
  name: string;
  slug: string;
  type: PartnerType;
  plan: PlanType;
  maxOrganizations: number | null;
  maxDevices: number | null;
  settings: Record<string, unknown>;
  ssoConfig: Record<string, unknown> | null;
  billingEmail: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface Organization {
  id: string;
  partnerId: string;
  name: string;
  slug: string;
  type: OrgType;
  status: OrgStatus;
  maxDevices: number | null;
  settings: Record<string, unknown>;
  ssoConfig: Record<string, unknown> | null;
  contractStart: Date | null;
  contractEnd: Date | null;
  billingContact: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface Site {
  id: string;
  orgId: string;
  name: string;
  address: Record<string, unknown> | null;
  timezone: string;
  contact: Record<string, unknown> | null;
  settings: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

// ============================================
// User & Access Control Types
// ============================================

export type UserStatus = 'active' | 'invited' | 'disabled';
export type RoleScope = 'system' | 'partner' | 'organization';
export type OrgAccessLevel = 'all' | 'selected' | 'none';

export interface User {
  id: string;
  email: string;
  name: string;
  passwordHash: string | null;
  mfaSecret: string | null;
  mfaEnabled: boolean;
  status: UserStatus;
  avatarUrl: string | null;
  lastLoginAt: Date | null;
  passwordChangedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Role {
  id: string;
  partnerId: string | null;
  orgId: string | null;
  scope: RoleScope;
  name: string;
  description: string | null;
  isSystem: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface Permission {
  id: string;
  resource: string;
  action: string;
  description: string | null;
}

export interface PartnerUser {
  id: string;
  partnerId: string;
  userId: string;
  roleId: string;
  orgAccess: OrgAccessLevel;
  orgIds: string[] | null;
  createdAt: Date;
}

export interface OrganizationUser {
  id: string;
  orgId: string;
  userId: string;
  roleId: string;
  siteIds: string[] | null;
  deviceGroupIds: string[] | null;
  createdAt: Date;
}

// ============================================
// Device Types
// ============================================

export type OSType = 'windows' | 'macos' | 'linux';
export type DeviceStatus = 'online' | 'offline' | 'maintenance' | 'decommissioned';
export type DeviceGroupType = 'static' | 'dynamic';
export type GroupMembershipSource = 'manual' | 'dynamic_rule' | 'policy';

export interface Device {
  id: string;
  orgId: string;
  siteId: string;
  agentId: string;
  hostname: string;
  displayName: string | null;
  osType: OSType;
  osVersion: string;
  osBuild: string | null;
  architecture: string;
  agentVersion: string;
  status: DeviceStatus;
  lastSeenAt: Date | null;
  enrolledAt: Date;
  enrolledBy: string | null;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface DeviceHardware {
  deviceId: string;
  cpuModel: string | null;
  cpuCores: number | null;
  cpuThreads: number | null;
  ramTotalMb: number | null;
  diskTotalGb: number | null;
  gpuModel: string | null;
  serialNumber: string | null;
  manufacturer: string | null;
  model: string | null;
  biosVersion: string | null;
  updatedAt: Date;
}

export interface DeviceMetrics {
  deviceId: string;
  timestamp: Date;
  cpuPercent: number;
  ramPercent: number;
  ramUsedMb: number;
  diskPercent: number;
  diskUsedGb: number;
  networkInBytes: bigint | null;
  networkOutBytes: bigint | null;
  processCount: number | null;
  customMetrics: Record<string, unknown> | null;
}

export interface DeviceGroup {
  id: string;
  orgId: string;
  siteId: string | null;
  name: string;
  type: DeviceGroupType;
  rules: Record<string, unknown> | null;
  parentId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// ============================================
// Script Types
// ============================================

export type ScriptLanguage = 'powershell' | 'bash' | 'python' | 'cmd';
export type ScriptRunAs = 'system' | 'user' | 'elevated';
export type ExecutionStatus = 'pending' | 'queued' | 'running' | 'completed' | 'failed' | 'timeout' | 'cancelled';
export type TriggerType = 'manual' | 'scheduled' | 'alert' | 'policy';

export interface Script {
  id: string;
  orgId: string | null;
  name: string;
  description: string | null;
  category: string | null;
  osTypes: OSType[];
  language: ScriptLanguage;
  content: string;
  parameters: Record<string, unknown> | null;
  timeoutSeconds: number;
  runAs: ScriptRunAs;
  isSystem: boolean;
  version: number;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ScriptExecution {
  id: string;
  scriptId: string;
  deviceId: string;
  triggeredBy: string | null;
  triggerType: TriggerType;
  parameters: Record<string, unknown> | null;
  status: ExecutionStatus;
  startedAt: Date | null;
  completedAt: Date | null;
  exitCode: number | null;
  stdout: string | null;
  stderr: string | null;
  errorMessage: string | null;
  createdAt: Date;
}

// ============================================
// Automation Types
// ============================================

export type AutomationTriggerType = 'schedule' | 'event' | 'webhook' | 'manual';
export type AutomationOnFailure = 'stop' | 'continue' | 'notify';
export type AutomationRunStatus = 'running' | 'completed' | 'failed' | 'partial';
export type PolicyEnforcement = 'monitor' | 'warn' | 'enforce';
export type ComplianceStatus = 'compliant' | 'non_compliant' | 'pending' | 'error';

export interface Automation {
  id: string;
  orgId: string;
  name: string;
  description: string | null;
  enabled: boolean;
  trigger: Record<string, unknown>;
  conditions: Record<string, unknown> | null;
  actions: Record<string, unknown>[];
  onFailure: AutomationOnFailure;
  notificationTargets: Record<string, unknown> | null;
  lastRunAt: Date | null;
  runCount: number;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Policy {
  id: string;
  orgId: string;
  name: string;
  description: string | null;
  enabled: boolean;
  targets: Record<string, unknown>;
  rules: Record<string, unknown>[];
  enforcement: PolicyEnforcement;
  checkIntervalMinutes: number;
  remediationScriptId: string | null;
  lastEvaluatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// ============================================
// Alert Types
// ============================================

export type AlertSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type AlertStatus = 'active' | 'acknowledged' | 'resolved' | 'suppressed';
export type NotificationChannelType = 'email' | 'slack' | 'teams' | 'webhook' | 'pagerduty' | 'sms';

export interface AlertRule {
  id: string;
  orgId: string;
  name: string;
  description: string | null;
  enabled: boolean;
  severity: AlertSeverity;
  targets: Record<string, unknown>;
  conditions: Record<string, unknown>;
  cooldownMinutes: number;
  escalationPolicyId: string | null;
  notificationChannels: Record<string, unknown>[];
  autoResolve: boolean;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Alert {
  id: string;
  ruleId: string;
  deviceId: string;
  orgId: string;
  status: AlertStatus;
  severity: AlertSeverity;
  title: string;
  message: string | null;
  context: Record<string, unknown> | null;
  triggeredAt: Date;
  acknowledgedAt: Date | null;
  acknowledgedBy: string | null;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
  createdAt: Date;
}

// ============================================
// Remote Access Types
// ============================================

export type RemoteSessionType = 'terminal' | 'desktop' | 'file_transfer';
export type RemoteSessionStatus = 'pending' | 'connecting' | 'active' | 'disconnected' | 'failed';
export type FileTransferDirection = 'upload' | 'download';
export type FileTransferStatus = 'pending' | 'transferring' | 'completed' | 'failed';

export interface RemoteSession {
  id: string;
  deviceId: string;
  userId: string;
  type: RemoteSessionType;
  status: RemoteSessionStatus;
  startedAt: Date | null;
  endedAt: Date | null;
  durationSeconds: number | null;
  bytesTransferred: bigint | null;
  recordingUrl: string | null;
  createdAt: Date;
}

// ============================================
// Audit Types
// ============================================

export type ActorType = 'user' | 'api_key' | 'agent' | 'system';
export type AuditResult = 'success' | 'failure' | 'denied';

export interface AuditLog {
  id: string;
  orgId: string;
  timestamp: Date;
  actorType: ActorType;
  actorId: string;
  actorEmail: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  resourceName: string | null;
  details: Record<string, unknown> | null;
  ipAddress: string | null;
  userAgent: string | null;
  result: AuditResult;
  errorMessage: string | null;
  checksum: string | null;
}

// ============================================
// Filter System Types
// ============================================

export * from './filters';
