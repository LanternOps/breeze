import { z } from 'zod';
import {
  OS_TYPES,
  DEVICE_STATUSES,
  ALERT_SEVERITIES,
  SCRIPT_LANGUAGES,
  SCRIPT_RUN_AS,
  EXECUTION_STATUSES,
  ROLE_SCOPES,
  USER_STATUSES,
  NOTIFICATION_CHANNEL_TYPES
} from '../constants';

// ============================================
// Common Validators
// ============================================

export const paginationSchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(50)
});

export const uuidSchema = z.string().uuid();

export const dateRangeSchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional()
});

// ============================================
// Auth Validators
// ============================================

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8)
});

export const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1).max(255)
});

export const forgotPasswordSchema = z.object({
  email: z.string().email()
});

export const refreshTokenSchema = z.object({
  refreshToken: z.string()
});

export const mfaVerifySchema = z.object({
  code: z.string().length(6)
});

export const passwordResetSchema = z.object({
  token: z.string(),
  password: z.string().min(8)
});

// ============================================
// Organization Validators
// ============================================

export const createOrgSchema = z.object({
  name: z.string().min(1).max(255),
  type: z.enum(['customer', 'internal']).default('customer'),
  maxDevices: z.number().positive().optional(),
  contractStart: z.coerce.date().optional(),
  contractEnd: z.coerce.date().optional(),
  billingContact: z.record(z.unknown()).optional()
});

export const createSiteSchema = z.object({
  name: z.string().min(1).max(255),
  address: z.record(z.unknown()).optional(),
  timezone: z.string().default('UTC'),
  contact: z.record(z.unknown()).optional()
});

// ============================================
// User Validators
// ============================================

export const inviteUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(255),
  roleId: z.string().uuid(),
  orgAccess: z.enum(['all', 'selected', 'none']).optional(),
  orgIds: z.array(z.string().uuid()).optional(),
  siteIds: z.array(z.string().uuid()).optional(),
  deviceGroupIds: z.array(z.string().uuid()).optional()
});

export const createRoleSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  scope: z.enum(ROLE_SCOPES),
  permissions: z.array(z.string())
});

// ============================================
// Device Validators
// ============================================

export const updateDeviceSchema = z.object({
  displayName: z.string().max(255).optional(),
  siteId: z.string().uuid().optional(),
  tags: z.array(z.string().max(50)).max(20).optional()
});

export const createDeviceGroupSchema = z.object({
  name: z.string().min(1).max(255),
  siteId: z.string().uuid().optional(),
  type: z.enum(['static', 'dynamic']),
  rules: z.record(z.unknown()).optional(),
  parentId: z.string().uuid().optional()
});

export const deviceQuerySchema = paginationSchema.extend({
  status: z.enum(DEVICE_STATUSES).optional(),
  osType: z.enum(OS_TYPES).optional(),
  siteId: z.string().uuid().optional(),
  groupId: z.string().uuid().optional(),
  search: z.string().optional()
});

// ============================================
// Script Validators
// ============================================

export const createScriptSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  category: z.string().max(100).optional(),
  osTypes: z.array(z.enum(OS_TYPES)).min(1),
  language: z.enum(SCRIPT_LANGUAGES),
  content: z.string().min(1),
  parameters: z.record(z.unknown()).optional(),
  timeoutSeconds: z.number().min(1).max(3600).default(300),
  runAs: z.enum(SCRIPT_RUN_AS).default('system')
});

export const executeScriptSchema = z.object({
  deviceIds: z.array(z.string().uuid()).optional(),
  groupId: z.string().uuid().optional(),
  parameters: z.record(z.unknown()).optional()
}).refine(
  (data) => data.deviceIds?.length || data.groupId,
  { message: 'Must provide either deviceIds or groupId' }
);

// ============================================
// Automation Validators
// ============================================

export const automationTriggerSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('schedule'),
    cron: z.string(),
    timezone: z.string().default('UTC')
  }),
  z.object({
    type: z.literal('event'),
    event: z.string(),
    durationMinutes: z.number().optional()
  }),
  z.object({
    type: z.literal('webhook'),
    secret: z.string().optional()
  }),
  z.object({
    type: z.literal('manual')
  })
]);

export const createAutomationSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  enabled: z.boolean().default(true),
  trigger: automationTriggerSchema,
  conditions: z.record(z.unknown()).optional(),
  actions: z.array(z.record(z.unknown())).min(1),
  onFailure: z.enum(['stop', 'continue', 'notify']).default('stop'),
  notificationTargets: z.record(z.unknown()).optional()
});

export const createPolicySchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  enabled: z.boolean().default(true),
  targets: z.record(z.unknown()),
  rules: z.array(z.record(z.unknown())).min(1),
  enforcement: z.enum(['monitor', 'warn', 'enforce']).default('monitor'),
  checkIntervalMinutes: z.number().min(5).max(1440).default(60),
  remediationScriptId: z.string().uuid().optional()
});

// ============================================
// Alert Validators
// ============================================

export const createAlertRuleSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  enabled: z.boolean().default(true),
  severity: z.enum(ALERT_SEVERITIES),
  targets: z.record(z.unknown()),
  conditions: z.record(z.unknown()),
  cooldownMinutes: z.number().min(1).max(1440).default(15),
  escalationPolicyId: z.string().uuid().optional(),
  notificationChannels: z.array(z.record(z.unknown())).optional(),
  autoResolve: z.boolean().default(true)
});

export const alertQuerySchema = paginationSchema.extend({
  status: z.enum(['active', 'acknowledged', 'resolved', 'suppressed']).optional(),
  severity: z.enum(ALERT_SEVERITIES).optional(),
  deviceId: z.string().uuid().optional()
});

// ============================================
// Agent Validators
// ============================================

export const agentEnrollSchema = z.object({
  enrollmentKey: z.string(),
  hostname: z.string(),
  osType: z.enum(OS_TYPES),
  osVersion: z.string(),
  architecture: z.string(),
  hardwareInfo: z.object({
    cpuModel: z.string().optional(),
    cpuCores: z.number().optional(),
    ramTotalMb: z.number().optional(),
    serialNumber: z.string().optional(),
    manufacturer: z.string().optional(),
    model: z.string().optional()
  }).optional()
});

export const agentHeartbeatSchema = z.object({
  metrics: z.object({
    cpuPercent: z.number().min(0).max(100),
    ramPercent: z.number().min(0).max(100),
    ramUsedMb: z.number().min(0),
    diskPercent: z.number().min(0).max(100),
    diskUsedGb: z.number().min(0),
    networkInBytes: z.number().optional(),
    networkOutBytes: z.number().optional(),
    bandwidthInBps: z.number().int().min(0).optional(),
    bandwidthOutBps: z.number().int().min(0).optional(),
    interfaceStats: z.array(z.object({
      name: z.string().min(1),
      inBytesPerSec: z.number().int().min(0),
      outBytesPerSec: z.number().int().min(0),
      inBytes: z.number().int().min(0),
      outBytes: z.number().int().min(0),
      inPackets: z.number().int().min(0),
      outPackets: z.number().int().min(0),
      inErrors: z.number().int().min(0),
      outErrors: z.number().int().min(0),
      speed: z.number().int().min(0).optional()
    })).max(100).optional(),
    processCount: z.number().optional()
  }),
  status: z.enum(['ok', 'warning', 'error']),
  agentVersion: z.string(),
  pendingReboot: z.boolean().optional(),
  lastUser: z.string().optional()
});

export const commandResultSchema = z.object({
  status: z.enum(['completed', 'failed', 'timeout']),
  exitCode: z.number().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  durationMs: z.number()
});

// ============================================
// Filter Validators
// ============================================

export * from './filters';

// ============================================
// Audit Validators
// ============================================

export const auditQuerySchema = paginationSchema.merge(dateRangeSchema).extend({
  actorId: z.string().uuid().optional(),
  actorType: z.enum(['user', 'api_key', 'agent', 'system']).optional(),
  action: z.string().optional(),
  resourceType: z.string().optional(),
  resourceId: z.string().uuid().optional(),
  result: z.enum(['success', 'failure', 'denied']).optional()
});

// ============================================
// AI Validators
// ============================================

export * from './ai';
