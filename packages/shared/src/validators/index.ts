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

export * from './reliability';
export * from './businessEmail';
export * from './remoteAccessLauncherScheme';
export * from './remoteAccessInlineSettings';
export * from './safeRelativePath';
export * from './authenticator';
export * from './catalog';
export * from './invoices';
export * from './contracts';
export * from './mlFeedback';
export * from './quotes';
export * from './contractTemplates';
export * from './maintenanceWindow';
export * from './agentVersionPins';
export * from './softwareDetection';

// ============================================
// Device Roles
// ============================================

export const DEVICE_ROLES = [
  'workstation', 'server', 'printer', 'router', 'switch',
  'firewall', 'access_point', 'phone', 'iot', 'camera', 'nas', 'unknown'
] as const;
export type DeviceRole = typeof DEVICE_ROLES[number];

// Orthogonal virtualization attribute (issue #1387). A virtual/VDI box is still
// a workstation (or server) — virtualization is a SECOND targeting axis, not a
// device role. The agent derives the platform from SMBIOS hardware identity
// strings (Manufacturer/Model/BIOS); these tokens are kept in sync with the
// agent's classify.go virtualizationMarkers list.
export const VIRTUALIZATION_PLATFORMS = [
  'vmware', 'hyperv', 'virtualbox', 'qemu', 'kvm', 'xen', 'bochs', 'parallels'
] as const;
export type VirtualizationPlatform = typeof VIRTUALIZATION_PLATFORMS[number];

// ============================================
// Common Validators
// ============================================

export const paginationSchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(50)
});

export const uuidSchema = z.string().guid();

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
  billingContact: z.record(z.string(), z.unknown()).optional()
});

export const createSiteSchema = z.object({
  name: z.string().min(1).max(255),
  address: z.record(z.string(), z.unknown()).optional(),
  timezone: z.string().default('UTC'),
  contact: z.record(z.string(), z.unknown()).optional()
});

// ============================================
// User Validators
// ============================================

export const inviteUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(255),
  roleId: z.string().guid(),
  orgAccess: z.enum(['all', 'selected', 'none']).optional(),
  orgIds: z.array(z.string().guid()).optional(),
  siteIds: z.array(z.string().guid()).optional(),
  deviceGroupIds: z.array(z.string().guid()).optional()
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
  // Nullable so callers can explicitly clear the display name; the
  // devices.display_name column is nullable. Keep in sync with the route
  // schema in apps/api/src/routes/devices/schemas.ts.
  displayName: z.string().max(255).nullable().optional(),
  siteId: z.string().guid().optional(),
  tags: z.array(z.string().max(50)).max(20).optional()
});

export const createDeviceGroupSchema = z.object({
  name: z.string().min(1).max(255),
  siteId: z.string().guid().optional(),
  type: z.enum(['static', 'dynamic']),
  rules: z.record(z.string(), z.unknown()).optional(),
  parentId: z.string().guid().optional()
});

export const deviceQuerySchema = paginationSchema.extend({
  status: z.enum(DEVICE_STATUSES).optional(),
  osType: z.enum(OS_TYPES).optional(),
  siteId: z.string().guid().optional(),
  groupId: z.string().guid().optional(),
  search: z.string().optional()
});

// ============================================
// Script Validators
// ============================================

// Feature #3 (severity-by-exit-code): exit code → AlertSeverity (or null = no alert).
// Keys must be non-negative integer strings (e.g. "0", "1", "2"). Negative or
// fractional codes are runtime-only (SIGKILL = -9 on Unix); the schema only
// accepts the canonical wire-format representation.
//
// Lives here so route handlers, UI forms, and tests all import the same shape.
export const alertSeverityValueSchema = z.enum(['critical', 'high', 'medium', 'low', 'info']);
export const exitCodeSeverityMappingSchema = z.record(
  z.string().regex(/^\d+$/, 'Exit codes must be non-negative integer strings'),
  alertSeverityValueSchema.nullable()
);

export const createScriptSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  category: z.string().max(100).optional(),
  osTypes: z.array(z.enum(OS_TYPES)).min(1),
  language: z.enum(SCRIPT_LANGUAGES),
  content: z.string().min(1),
  parameters: z.record(z.string(), z.unknown()).optional(),
  timeoutSeconds: z.number().min(1).max(3600).default(300),
  runAs: z.enum(SCRIPT_RUN_AS).default('system')
});

export const executeScriptSchema = z.object({
  deviceIds: z.array(z.string().guid()).optional(),
  groupId: z.string().guid().optional(),
  parameters: z.record(z.string(), z.unknown()).optional()
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
    secret: z.string().min(1)
  }),
  z.object({
    type: z.literal('manual')
  })
]);

export const automationActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('run_script'),
    scriptId: z.string().guid(),
    parameters: z.record(z.string(), z.unknown()).optional(),
    runAs: z.string().optional(),
  }),
  z.object({
    type: z.literal('send_notification'),
    notificationChannelId: z.string().guid(),
    title: z.string().optional(),
    message: z.string().optional(),
    severity: z.enum(['critical', 'high', 'medium', 'low', 'info']).optional(),
  }),
  z.object({
    type: z.literal('create_alert'),
    alertSeverity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
    alertMessage: z.string(),
    alertTitle: z.string().optional(),
  }),
  z.object({
    type: z.literal('execute_command'),
    command: z.string(),
    shell: z.enum(['bash', 'powershell', 'cmd']).optional(),
  }),
  z.object({
    type: z.literal('deploy_software'),
    catalogId: z.string().guid(),
  }),
]);

export const createAutomationSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  enabled: z.boolean().default(true),
  trigger: automationTriggerSchema,
  conditions: z.record(z.string(), z.unknown()).optional(),
  actions: z.array(automationActionSchema).min(1),
  onFailure: z.enum(['stop', 'continue', 'notify']).default('stop'),
  notificationTargets: z.record(z.string(), z.unknown()).optional()
});

export const createPolicySchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  enabled: z.boolean().default(true),
  targets: z.record(z.string(), z.unknown()),
  rules: z.array(z.record(z.string(), z.unknown())).min(1),
  enforcement: z.enum(['monitor', 'warn', 'enforce']).default('monitor'),
  checkIntervalMinutes: z.number().min(5).max(1440).default(60),
  remediationScriptId: z.string().guid().optional()
});

// ============================================
// Alert Validators
// ============================================

export const createAlertRuleSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  enabled: z.boolean().default(true),
  severity: z.enum(ALERT_SEVERITIES),
  targets: z.record(z.string(), z.unknown()),
  conditions: z.record(z.string(), z.unknown()),
  cooldownMinutes: z.number().min(1).max(1440).default(15),
  escalationPolicyId: z.string().guid().optional(),
  notificationChannels: z.array(z.record(z.string(), z.unknown())).optional(),
  autoResolve: z.boolean().default(true)
});

export const alertQuerySchema = paginationSchema.extend({
  status: z.enum(['active', 'acknowledged', 'resolved', 'suppressed', 'dismissed']).optional(),
  severity: z.enum(ALERT_SEVERITIES).optional(),
  deviceId: z.string().guid().optional()
});

// ============================================
// mTLS Settings Validators
// ============================================

export const orgMtlsSettingsSchema = z.object({
  certLifetimeDays: z.number().int().min(1).max(365).default(90),
  expiredCertPolicy: z.enum(['auto_reissue', 'quarantine']).default('auto_reissue')
});

// ============================================
// Helper Chat Settings Validators
// ============================================

export const orgHelperSettingsSchema = z.object({
  enabled: z.boolean().default(false),
});

// ============================================
// Log Forwarding Settings Validators
// ============================================

export const orgLogForwardingSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  elasticsearchUrl: z.string().trim().optional(),
  elasticsearchApiKey: z.string().trim().optional(),
  elasticsearchUsername: z.string().trim().optional(),
  elasticsearchPassword: z.string().optional(),
  indexPrefix: z.string().min(1).max(100).default('breeze-logs'),
}).superRefine((data, ctx) => {
  if (!data.enabled) {
    return;
  }

  if (!data.elasticsearchUrl) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['elasticsearchUrl'],
      message: 'Log endpoint URL is required when log forwarding is enabled',
    });
  } else {
    try {
      const parsed = new URL(data.elasticsearchUrl);
      if (parsed.protocol !== 'https:') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['elasticsearchUrl'],
          message: 'Log endpoint URL must use HTTPS',
        });
      }
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['elasticsearchUrl'],
        message: 'Log endpoint URL must be a valid URL',
      });
    }
  }

  const hasApiKey = Boolean(data.elasticsearchApiKey);
  const hasBasicUser = Boolean(data.elasticsearchUsername);
  const hasBasicPassword = Boolean(data.elasticsearchPassword);
  const hasBasic = hasBasicUser || hasBasicPassword;

  if (hasApiKey && hasBasic) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Choose either API key or username+password auth, not both',
    });
  }

  if (!hasApiKey && !(hasBasicUser && hasBasicPassword)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Either API key or username+password required for log endpoint auth',
    });
  }
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
    model: z.string().optional(),
    motherboardManufacturer: z.string().optional(),
    motherboardProduct: z.string().optional(),
    motherboardVersion: z.string().optional()
  }).optional()
});

export const agentHeartbeatSchema = z.object({
  metrics: z.object({
    cpuPercent: z.number().min(0).max(100),
    ramPercent: z.number().min(0).max(100),
    ramUsedMb: z.number().min(0),
    diskPercent: z.number().min(0).max(100),
    diskUsedGb: z.number().min(0),
    diskActivityAvailable: z.boolean().optional(),
    diskReadBytes: z.number().int().min(0).optional(),
    diskWriteBytes: z.number().int().min(0).optional(),
    diskReadBps: z.number().int().min(0).optional(),
    diskWriteBps: z.number().int().min(0).optional(),
    diskReadOps: z.number().int().min(0).optional(),
    diskWriteOps: z.number().int().min(0).optional(),
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

// Active-VPN-client presence (#2139). This is the AGENT-sent wire shape for one
// detected VPN — the API stamps `reportedAt` on ingest, so it is intentionally
// absent here. Mirrors the VpnPresence type in ../types minus reportedAt.
export const vpnProviderSchema = z.enum([
  'wireguard',
  'tailscale',
  'netbird',
  'zerotier',
  'openvpn',
  'cloudflare-warp',
  'generic'
]);

export const vpnDetectionSourceSchema = z.enum(['interface', 'service', 'process', 'adapter']);

export const vpnPresenceIngestSchema = z.object({
  provider: vpnProviderSchema,
  active: z.boolean(),
  interfaceName: z.string().min(1).max(128),
  ipv4: z.string().max(45).optional(),
  ipv6: z.string().max(45).optional(),
  dnsName: z.string().max(255).optional(),
  detectionSource: vpnDetectionSourceSchema
});

// ============================================
// Filter Validators
// ============================================

export * from './filters';

// ============================================
// Audit Validators
// ============================================

export const auditQuerySchema = paginationSchema.merge(dateRangeSchema).extend({
  actorId: z.string().guid().optional(),
  actorType: z.enum(['user', 'api_key', 'agent', 'system']).optional(),
  action: z.string().optional(),
  resourceType: z.string().optional(),
  resourceId: z.string().guid().optional(),
  result: z.enum(['success', 'failure', 'denied']).optional()
});

// ============================================
// Configuration Policy Validators
// ============================================

export const createConfigPolicySchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  status: z.enum(['active', 'inactive', 'archived']).optional(),
  orgId: z.string().guid().optional(),
  // Ownership axis (#1724). 'organization' (default) = the classic org-scoped
  // policy. 'partner' = partner-wide / all-orgs; the server derives the partner
  // from the caller's own partner_id — a client-supplied partner id is NEVER
  // trusted. orgId is ignored when ownerScope is 'partner'.
  ownerScope: z.enum(['organization', 'partner']).optional(),
});

export const updateConfigPolicySchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  status: z.enum(['active', 'inactive', 'archived']).optional(),
});

/**
 * Private database-to-export material used to reconstruct patch settings.
 * It is never valid in caller-controlled feature settings, regardless of the
 * feature type or nesting depth.
 */
export const CONFIG_POLICY_PATCH_INLINE_MIRROR_KEY = '__breezePatchInlineMirror';

export function containsConfigPolicyReservedKey(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;

  const pending: object[] = [value];
  const visited = new WeakSet<object>();
  let inspectedObjects = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    // JSON request bodies cannot contain cycles or shared object references.
    // Service callers can, so reject those structures instead of risking an
    // incomplete reservation scan. Bound work for the same fail-closed reason.
    if (visited.has(current) || inspectedObjects >= 10_000) return true;
    visited.add(current);
    inspectedObjects += 1;

    try {
      for (const key of Object.keys(current)) {
        if (key === CONFIG_POLICY_PATCH_INLINE_MIRROR_KEY) return true;
        const nested = (current as Record<string, unknown>)[key];
        if (nested !== null && typeof nested === 'object') pending.push(nested);
      }
    } catch {
      return true;
    }
  }
  return false;
}

export const configFeatureInlineSettingsSchema = z
  .record(z.string(), z.unknown())
  .superRefine((settings, ctx) => {
    if (containsConfigPolicyReservedKey(settings)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Reserved configuration feature material is not allowed',
      });
    }
  });

export const addFeatureLinkSchema = z.object({
  featureType: z.enum(['patch', 'alert_rule', 'backup', 'security', 'monitoring', 'maintenance', 'compliance', 'automation', 'event_log', 'software_policy', 'sensitive_data', 'peripheral_control', 'warranty', 'helper', 'remote_access', 'pam', 'onedrive_helper', 'vulnerability']),
  featurePolicyId: z.string().guid().optional(),
  inlineSettings: configFeatureInlineSettingsSchema.optional(),
}).refine(
  (data) => data.featurePolicyId || data.inlineSettings,
  { message: 'At least one of featurePolicyId or inlineSettings is required' }
);

const patchSourceValueSchema = z.enum([
  'os',
  'third_party',
  'custom',
  'firmware',
  'drivers',
  'microsoft',
  'apple',
  'linux',
]);

/**
 * Patch sources with no backing patch provider yet: they expand to an empty
 * allow-set at approval time (see patchApprovalEvaluator.buildAllowedPatchSources).
 * A selection made up ONLY of these would silently approve zero patches, so it
 * is rejected rather than saved as a no-op. Keep in sync with that expander.
 */
const PROVIDERLESS_PATCH_SOURCES = new Set<string>(['firmware', 'drivers']);

export const policyAppRuleSchema = z.object({
  source: z.enum(['third_party', 'custom']),
  packageId: z.string().min(1).max(256),
  displayName: z.string().max(255).optional(),
  action: z.enum(['block', 'pin']),
  pinnedVersion: z.string().min(1).max(64).optional(),
}).superRefine((data, ctx) => {
  if (data.action === 'pin' && !data.pinnedVersion) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['pinnedVersion'],
      message: 'Pinned version is required for pin rules.',
    });
  }
});

export type PolicyAppRule = z.infer<typeof policyAppRuleSchema>;

/**
 * Typed shape for an Update Ring's `patch_policies.autoApprove` JSONB column.
 *
 * Part of issue #1317 (move patch approval rules from Config Policy to Update
 * Rings). The ring owns the WHAT-installs auto-approval gate: an enabled flag,
 * the severities that auto-approve, and a deferral window (days after a patch's
 * release before it is eligible to auto-approve). Empty `severities` while
 * `enabled` means "nothing auto-approves" (fail-closed) — auto-approval must
 * always be an explicit opt-in to a specific severity set.
 *
 * The legacy/dormant `autoApprove` JSONB values (`{}`, `true`,
 * `{ enabled: true, severities: [...] }` without `deferralDays`) all still
 * parse downstream in patchApprovalEvaluator's `parseRingAutoApprove`, so this
 * stricter writer schema does not crash on already-stored rings. Note the read
 * path is fail-closed to MATCH this writer: an `enabled` ring with an empty
 * severity set (including the legacy boolean `true`) auto-approves NOTHING, so
 * a row that bypassed this schema (e.g. the manage_update_rings AI tool) can
 * never become more permissive than an explicitly-written one.
 */
export const ringAutoApproveSchema = z.object({
  enabled: z.boolean().default(false),
  severities: z.array(z.enum(['critical', 'important', 'moderate', 'low'])).default([]),
  deferralDays: z.number().int().min(0).max(365).default(0),
}).superRefine((data, ctx) => {
  if (data.enabled && data.severities.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['severities'],
      message: 'Select at least one severity for auto-approval.',
    });
  }
});

export type RingAutoApprove = z.infer<typeof ringAutoApproveSchema>;

export const patchInlineSettingsSchema = z.object({
  sources: z.array(patchSourceValueSchema).min(1).default(['os']),
  autoApprove: z.boolean().default(false),
  autoApproveSeverities: z.array(z.enum(['critical', 'important', 'moderate', 'low'])).default([]),
  autoApproveDeferralDays: z.number().int().min(0).max(60).default(0),
  apps: z.array(policyAppRuleSchema).max(200).default([]),
  scheduleFrequency: z.enum(['daily', 'weekly', 'monthly']).default('weekly'),
  scheduleTime: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/).default('02:00'),
  scheduleDayOfWeek: z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']).default('sun'),
  scheduleDayOfMonth: z.number().int().min(1).max(28).default(1),
  rebootPolicy: z.enum(['never', 'if_required', 'always', 'maintenance_window']).default('if_required'),
  // #1872: enforce Breeze as the sole patch source on Windows endpoints. When
  // true the agent suppresses the native Windows Update automatic-install
  // channel (NoAutoUpdate=1); Breeze's own WUA-driven installs are unaffected.
  exclusiveWindowsUpdate: z.boolean().default(false),
}).superRefine((data, ctx) => {
  if (data.autoApprove && data.autoApproveSeverities.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['autoApproveSeverities'],
      message: 'Select at least one severity for auto-approval.',
    });
  }

  if (data.sources.length > 0 && data.sources.every((s) => PROVIDERLESS_PATCH_SOURCES.has(s))) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['sources'],
      message: 'The selected patch sources (firmware/drivers) have no patch provider yet and would approve nothing. Include at least one of: os, third_party, custom.',
    });
  }

  const seen = new Set<string>();
  for (const [i, app] of data.apps.entries()) {
    // The approval evaluator matches 'third_party' and 'custom' as a single
    // bucket, so canonicalize the source when deduping to mirror that.
    const canonicalSource = app.source === 'custom' ? 'third_party' : app.source;
    const key = `${canonicalSource}|${app.packageId.toLowerCase()}`;
    if (seen.has(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['apps', i],
        message: 'Duplicate app rule for the same source and package.',
      });
    }
    seen.add(key);
  }
});

export const eventLogInlineSettingsSchema = z.object({
  retentionDays: z.number().int().min(7).max(365).default(30),
  maxEventsPerCycle: z.number().int().min(10).max(500).default(100),
  collectCategories: z.array(z.enum(['security', 'hardware', 'application', 'system'])).min(1).default(['security', 'hardware', 'application', 'system']),
  minimumLevel: z.enum(['info', 'warning', 'error', 'critical']).default('info'),
  // 15m default (was 5m) — each collection pass fans out subprocess work on
  // the agent; on macOS a `log show` pass costs seconds of CPU even when it
  // returns nothing (issue #2390). Still configurable 1-60.
  collectionIntervalMinutes: z.number().int().min(1).max(60).default(15),
  rateLimitPerHour: z.number().int().min(100).max(100000).default(12000),
});

export const sensitiveDataInlineSettingsSchema = z.object({
  detectionClasses: z.array(z.enum(['credential', 'pci', 'phi', 'pii', 'financial'])).min(1).default(['credential']),
  includePaths: z.array(z.string().min(1).max(2048)).max(256).default([]),
  excludePaths: z.array(z.string().min(1).max(2048)).max(256).default([]),
  fileTypes: z.array(z.string().min(1).max(32)).max(128).default([]),
  maxFileSizeBytes: z.number().int().min(1024).max(1073741824).default(104857600),
  workers: z.number().int().min(1).max(32).default(4),
  timeoutSeconds: z.number().int().min(5).max(1800).default(300),
  suppressPatternIds: z.array(z.string().min(1).max(80)).max(200).default([]),
  scheduleType: z.enum(['manual', 'interval', 'cron']).default('manual'),
  intervalMinutes: z.number().int().min(5).max(10080).optional(),
  cron: z.string().max(120).optional(),
  timezone: z.string().max(64).default('UTC'),
});

export const onedriveLibraryMappingSchema = z.object({
  libraryId: z.string().min(1).max(1024),
  displayName: z.string().min(1).max(255),
  siteUrl: z.string().max(1024).nullable().optional(),
  siteId: z.string().max(512).nullable().optional(),
  webId: z.string().max(128).nullable().optional(),
  listId: z.string().max(128).nullable().optional(),
  targetingMode: z.enum(['everyone', 'graph_group', 'local_ad_group']).default('everyone'),
  groupId: z.string().max(128).nullable().optional(),
  groupName: z.string().max(255).nullable().optional(),
  hiveScope: z.enum(['hkcu', 'hklm']).default('hkcu'),
  enabled: z.boolean().default(true),
}).superRefine((lib, ctx) => {
  if (lib.targetingMode === 'graph_group' && !lib.groupId && !lib.groupName) {
    ctx.addIssue({ code: 'custom', message: 'graph_group targeting requires groupId or groupName', path: ['groupId'] });
  }
  if (lib.targetingMode === 'local_ad_group' && !lib.groupName) {
    ctx.addIssue({ code: 'custom', message: 'local_ad_group targeting requires groupName (agent resolves by name)', path: ['groupName'] });
  }
});

export const onedriveHelperInlineSettingsSchema = z.object({
  silentAccountConfig: z.boolean().default(true),
  filesOnDemand: z.boolean().default(true),
  kfmSilentOptIn: z.boolean().default(false),
  kfmFolders: z.array(z.enum(['Desktop', 'Documents', 'Pictures'])).default(['Desktop', 'Documents', 'Pictures']),
  kfmBlockOptOut: z.boolean().default(false),
  tenantAssociationId: z.string().max(64).nullable().optional(),
  restartOnChange: z.boolean().default(true),
  libraries: z.array(onedriveLibraryMappingSchema).max(100).default([]),
});

export const monitoringInlineSettingsSchema = z.object({
  checkIntervalSeconds: z.number().int().min(10).max(3600).default(60),
  watches: z.array(z.object({
    watchType: z.enum(['service', 'process']),
    name: z.string().min(1).max(255),
    displayName: z.string().max(255).optional(),
    enabled: z.boolean().default(true),
    alertOnStop: z.boolean().default(true),
    alertAfterConsecutiveFailures: z.number().int().min(1).max(100).default(2),
    alertSeverity: z.enum(['critical', 'high', 'medium', 'low', 'info']).default('high'),
    cpuThresholdPercent: z.number().min(0).max(100).optional(),
    memoryThresholdMb: z.number().min(0).optional(),
    thresholdDurationSeconds: z.number().int().min(0).max(86400).default(300),
    autoRestart: z.boolean().default(false),
    maxRestartAttempts: z.number().int().min(0).max(50).default(3),
    restartCooldownSeconds: z.number().int().min(30).max(86400).default(300),
  })).max(200).default([]),
  eventLogAlerts: z.array(z.object({
    name: z.string().min(1).max(255),
    category: z.enum(['security', 'hardware', 'application', 'system']),
    level: z.enum(['warning', 'error', 'critical']),
    sourcePattern: z.string().max(500).optional(),
    messagePattern: z.string().max(500).optional(),
    countThreshold: z.number().int().min(1).max(10000).default(1),
    windowMinutes: z.number().int().min(1).max(1440).default(15),
    severity: z.enum(['critical', 'high', 'medium', 'low', 'info']).default('high'),
    enabled: z.boolean().default(true),
  })).max(50).default([]),
  alertRules: z.array(z.object({
    name: z.string().min(1).max(255),
    severity: z.enum(['critical', 'high', 'medium', 'low', 'info']).default('medium'),
    conditions: z.array(z.object({
      type: z.enum(['metric', 'status', 'custom']),
      metric: z.string().optional(),
      operator: z.string().optional(),
      value: z.number().optional(),
      duration: z.number().optional(),
      field: z.string().optional(),
      customCondition: z.string().optional(),
    })).min(1),
    cooldownMinutes: z.number().int().min(1).max(1440).default(15),
    autoResolve: z.boolean().default(false),
  })).max(100).default([]),
});

export const updateFeatureLinkSchema = z.object({
  featurePolicyId: z.string().guid().nullable().optional(),
  inlineSettings: configFeatureInlineSettingsSchema.nullable().optional(),
});

export const assignPolicySchema = z.object({
  level: z.enum(['partner', 'organization', 'site', 'device_group', 'device']),
  // Optional: for the 'partner' level the server derives the target from the
  // caller's / policy's own partner_id (#1724) and ignores any client value.
  // Required (enforced server-side) for all other levels.
  targetId: z.string().guid().optional(),
  priority: z.number().int().min(0).max(1000).optional(),
  roleFilter: z.array(z.enum(DEVICE_ROLES)).optional(),
  osFilter: z.array(z.enum(['windows', 'macos', 'linux'])).optional(),
});

export const diffSchema = z.object({
  add: z.array(z.object({
    configPolicyId: z.string().guid(),
    level: z.enum(['partner', 'organization', 'site', 'device_group', 'device']),
    targetId: z.string().guid(),
    priority: z.number().int().min(0).optional(),
  })).optional(),
  remove: z.array(z.string().guid()).optional(),
});

export const listConfigPoliciesSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  status: z.enum(['active', 'inactive', 'archived']).optional(),
  search: z.string().optional(),
  orgId: z.string().guid().optional(),
});

export const targetQuerySchema = z.object({
  level: z.enum(['partner', 'organization', 'site', 'device_group', 'device']),
  targetId: z.string().guid(),
});

export const configPolicyIdParamSchema = z.object({ id: z.string().guid() });
export const configPolicyLinkIdParamSchema = z.object({ id: z.string().guid(), linkId: z.string().guid() });
export const configPolicyAssignmentIdParamSchema = z.object({ id: z.string().guid(), aid: z.string().guid() });
export const configPolicyDeviceIdParamSchema = z.object({ deviceId: z.string().guid() });

// ============================================
// AI Validators
// ============================================

export * from './ai';

// ============================================
// Ticket Validators
// ============================================

export * from './tickets';
export * from './ticketForms';
export * from './timeEntries';
export * from './portal';
export * from './ticketConfig';
export * from './clientAiDlp';

// ============================================
// Backup Target Validators
// ============================================

export {
  backupExcludePatternsSchema,
  fileTargetsSchema,
  hypervTargetsSchema,
  mssqlTargetsSchema,
  systemImageTargetsSchema,
  backupModeSchema,
  backupScheduleSchema,
  backupRetentionSchema,
  backupRetentionUpdateSchema,
  backupInlineSettingsSchema,
  backupProfileLinkedInlineSettingsSchema,
  backupProfileSelectionsSchema,
  enabledBackupSelections,
  createBackupProfileSchema,
  updateBackupProfileSchema,
  type BackupMode,
  type BackupSchedule,
  type BackupRetention,
  type BackupInlineSettings,
  type BackupProfileSelections,
  type CreateBackupProfileInput,
  type UpdateBackupProfileInput,
} from './backupTargets';
