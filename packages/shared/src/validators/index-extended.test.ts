import { describe, it, expect } from 'vitest';
import {
  // Auth
  forgotPasswordSchema,
  refreshTokenSchema,
  // Automation
  automationTriggerSchema,
  createAutomationSchema,
  createPolicySchema,
  // Alert
  createAlertRuleSchema,
  // mTLS
  orgMtlsSettingsSchema,
  // Helper
  orgHelperSettingsSchema,
  // Log Forwarding
  orgLogForwardingSettingsSchema,
  // Agent
  agentEnrollSchema,
  commandResultSchema,
  // Audit
  auditQuerySchema,
  // Config Policy
  createConfigPolicySchema,
  updateConfigPolicySchema,
  addFeatureLinkSchema,
  eventLogInlineSettingsSchema,
  sensitiveDataInlineSettingsSchema,
  monitoringInlineSettingsSchema,
  updateFeatureLinkSchema,
  assignPolicySchema,
  diffSchema,
  listConfigPoliciesSchema,
  targetQuerySchema,
  configPolicyIdParamSchema,
  configPolicyLinkIdParamSchema,
  configPolicyAssignmentIdParamSchema,
  configPolicyDeviceIdParamSchema,
  // Device Roles
  DEVICE_ROLES,
} from './index';

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';
const VALID_UUID_2 = '660e8400-e29b-41d4-a716-446655440001';

// ============================================
// Device Roles
// ============================================

describe('DEVICE_ROLES', () => {
  it('should contain all expected roles', () => {
    expect(DEVICE_ROLES).toContain('workstation');
    expect(DEVICE_ROLES).toContain('server');
    expect(DEVICE_ROLES).toContain('printer');
    expect(DEVICE_ROLES).toContain('router');
    expect(DEVICE_ROLES).toContain('switch');
    expect(DEVICE_ROLES).toContain('firewall');
    expect(DEVICE_ROLES).toContain('access_point');
    expect(DEVICE_ROLES).toContain('phone');
    expect(DEVICE_ROLES).toContain('iot');
    expect(DEVICE_ROLES).toContain('camera');
    expect(DEVICE_ROLES).toContain('nas');
    expect(DEVICE_ROLES).toContain('unknown');
    expect(DEVICE_ROLES.length).toBe(12);
  });
});

// ============================================
// Auth Validators (not covered in existing tests)
// ============================================

describe('forgotPasswordSchema', () => {
  it('should accept valid email', () => {
    const result = forgotPasswordSchema.safeParse({ email: 'user@example.com' });
    expect(result.success).toBe(true);
  });

  it('should reject invalid email', () => {
    expect(forgotPasswordSchema.safeParse({ email: 'bad' }).success).toBe(false);
    expect(forgotPasswordSchema.safeParse({ email: '' }).success).toBe(false);
    expect(forgotPasswordSchema.safeParse({}).success).toBe(false);
  });
});

describe('refreshTokenSchema', () => {
  it('should accept any non-empty string', () => {
    const result = refreshTokenSchema.safeParse({ refreshToken: 'abc123' });
    expect(result.success).toBe(true);
  });

  it('should reject missing refreshToken', () => {
    const result = refreshTokenSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

// ============================================
// Automation Trigger
// ============================================

describe('automationTriggerSchema', () => {
  it('should accept schedule trigger', () => {
    const result = automationTriggerSchema.safeParse({
      type: 'schedule',
      cron: '0 */6 * * *',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.timezone).toBe('UTC'); // default
    }
  });

  it('should accept schedule trigger with custom timezone', () => {
    const result = automationTriggerSchema.safeParse({
      type: 'schedule',
      cron: '0 9 * * 1-5',
      timezone: 'America/New_York',
    });
    expect(result.success).toBe(true);
  });

  it('should accept event trigger', () => {
    const result = automationTriggerSchema.safeParse({
      type: 'event',
      event: 'device.offline',
    });
    expect(result.success).toBe(true);
  });

  it('should accept event trigger with durationMinutes', () => {
    const result = automationTriggerSchema.safeParse({
      type: 'event',
      event: 'device.high_cpu',
      durationMinutes: 15,
    });
    expect(result.success).toBe(true);
  });

  it('should accept webhook trigger', () => {
    const result = automationTriggerSchema.safeParse({
      type: 'webhook',
    });
    expect(result.success).toBe(true);
  });

  it('should accept webhook trigger with secret', () => {
    const result = automationTriggerSchema.safeParse({
      type: 'webhook',
      secret: 'whsec_abc123',
    });
    expect(result.success).toBe(true);
  });

  it('should accept manual trigger', () => {
    const result = automationTriggerSchema.safeParse({
      type: 'manual',
    });
    expect(result.success).toBe(true);
  });

  it('should reject unknown trigger type', () => {
    const result = automationTriggerSchema.safeParse({
      type: 'cron',
    });
    expect(result.success).toBe(false);
  });

  it('should reject schedule without cron', () => {
    const result = automationTriggerSchema.safeParse({
      type: 'schedule',
    });
    expect(result.success).toBe(false);
  });

  it('should reject event without event name', () => {
    const result = automationTriggerSchema.safeParse({
      type: 'event',
    });
    expect(result.success).toBe(false);
  });
});

describe('createAutomationSchema', () => {
  const validAutomation = {
    name: 'Restart on failure',
    trigger: { type: 'event' as const, event: 'service.stopped' },
    actions: [{ type: 'script', scriptId: VALID_UUID }],
  };

  it('should accept valid automation', () => {
    const result = createAutomationSchema.safeParse(validAutomation);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(true); // default
      expect(result.data.onFailure).toBe('stop'); // default
    }
  });

  it('should accept all onFailure values', () => {
    const values = ['stop', 'continue', 'notify'] as const;
    for (const onFailure of values) {
      const result = createAutomationSchema.safeParse({
        ...validAutomation,
        onFailure,
      });
      expect(result.success).toBe(true);
    }
  });

  it('should reject empty name', () => {
    const result = createAutomationSchema.safeParse({
      ...validAutomation,
      name: '',
    });
    expect(result.success).toBe(false);
  });

  it('should reject name over 255 chars', () => {
    const result = createAutomationSchema.safeParse({
      ...validAutomation,
      name: 'x'.repeat(256),
    });
    expect(result.success).toBe(false);
  });

  it('should reject empty actions', () => {
    const result = createAutomationSchema.safeParse({
      ...validAutomation,
      actions: [],
    });
    expect(result.success).toBe(false);
  });

  it('should reject description over 2000 chars', () => {
    const result = createAutomationSchema.safeParse({
      ...validAutomation,
      description: 'x'.repeat(2001),
    });
    expect(result.success).toBe(false);
  });
});

describe('createPolicySchema', () => {
  const validPolicy = {
    name: 'Antivirus Required',
    targets: { osType: 'windows' },
    rules: [{ check: 'antivirus_installed', expected: true }],
  };

  it('should accept valid policy', () => {
    const result = createPolicySchema.safeParse(validPolicy);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(true); // default
      expect(result.data.enforcement).toBe('monitor'); // default
      expect(result.data.checkIntervalMinutes).toBe(60); // default
    }
  });

  it('should accept all enforcement values', () => {
    const values = ['monitor', 'warn', 'enforce'] as const;
    for (const enforcement of values) {
      const result = createPolicySchema.safeParse({ ...validPolicy, enforcement });
      expect(result.success).toBe(true);
    }
  });

  it('should reject checkIntervalMinutes below 5', () => {
    const result = createPolicySchema.safeParse({
      ...validPolicy,
      checkIntervalMinutes: 4,
    });
    expect(result.success).toBe(false);
  });

  it('should reject checkIntervalMinutes above 1440', () => {
    const result = createPolicySchema.safeParse({
      ...validPolicy,
      checkIntervalMinutes: 1441,
    });
    expect(result.success).toBe(false);
  });

  it('should accept boundary checkIntervalMinutes', () => {
    expect(
      createPolicySchema.safeParse({ ...validPolicy, checkIntervalMinutes: 5 }).success
    ).toBe(true);
    expect(
      createPolicySchema.safeParse({ ...validPolicy, checkIntervalMinutes: 1440 }).success
    ).toBe(true);
  });

  it('should reject empty rules', () => {
    const result = createPolicySchema.safeParse({
      ...validPolicy,
      rules: [],
    });
    expect(result.success).toBe(false);
  });

  it('should accept optional remediationScriptId', () => {
    const result = createPolicySchema.safeParse({
      ...validPolicy,
      remediationScriptId: VALID_UUID,
    });
    expect(result.success).toBe(true);
  });

  it('should reject invalid remediationScriptId', () => {
    const result = createPolicySchema.safeParse({
      ...validPolicy,
      remediationScriptId: 'bad-id',
    });
    expect(result.success).toBe(false);
  });
});

// ============================================
// Alert Validators
// ============================================

describe('createAlertRuleSchema', () => {
  const validAlertRule = {
    name: 'High CPU Alert',
    severity: 'critical' as const,
    targets: { all: true },
    conditions: { metric: 'cpuPercent', operator: 'gt', value: 90 },
  };

  it('should accept valid alert rule', () => {
    const result = createAlertRuleSchema.safeParse(validAlertRule);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(true);
      expect(result.data.cooldownMinutes).toBe(15);
      expect(result.data.autoResolve).toBe(true);
    }
  });

  it('should accept all severity values', () => {
    const severities = ['critical', 'high', 'medium', 'low', 'info'] as const;
    for (const severity of severities) {
      const result = createAlertRuleSchema.safeParse({ ...validAlertRule, severity });
      expect(result.success).toBe(true);
    }
  });

  it('should reject cooldownMinutes below 1', () => {
    const result = createAlertRuleSchema.safeParse({
      ...validAlertRule,
      cooldownMinutes: 0,
    });
    expect(result.success).toBe(false);
  });

  it('should reject cooldownMinutes above 1440', () => {
    const result = createAlertRuleSchema.safeParse({
      ...validAlertRule,
      cooldownMinutes: 1441,
    });
    expect(result.success).toBe(false);
  });

  it('should accept optional escalationPolicyId', () => {
    const result = createAlertRuleSchema.safeParse({
      ...validAlertRule,
      escalationPolicyId: VALID_UUID,
    });
    expect(result.success).toBe(true);
  });
});

// ============================================
// mTLS Settings
// ============================================

describe('orgMtlsSettingsSchema', () => {
  it('should accept valid settings with defaults', () => {
    const result = orgMtlsSettingsSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.certLifetimeDays).toBe(90);
      expect(result.data.expiredCertPolicy).toBe('auto_reissue');
    }
  });

  it('should accept custom settings', () => {
    const result = orgMtlsSettingsSchema.safeParse({
      certLifetimeDays: 365,
      expiredCertPolicy: 'quarantine',
    });
    expect(result.success).toBe(true);
  });

  it('should reject certLifetimeDays below 1', () => {
    const result = orgMtlsSettingsSchema.safeParse({ certLifetimeDays: 0 });
    expect(result.success).toBe(false);
  });

  it('should reject certLifetimeDays above 365', () => {
    const result = orgMtlsSettingsSchema.safeParse({ certLifetimeDays: 366 });
    expect(result.success).toBe(false);
  });

  it('should accept boundary certLifetimeDays', () => {
    expect(orgMtlsSettingsSchema.safeParse({ certLifetimeDays: 1 }).success).toBe(true);
    expect(orgMtlsSettingsSchema.safeParse({ certLifetimeDays: 365 }).success).toBe(true);
  });

  it('should reject fractional certLifetimeDays', () => {
    const result = orgMtlsSettingsSchema.safeParse({ certLifetimeDays: 90.5 });
    expect(result.success).toBe(false);
  });

  it('should reject invalid expiredCertPolicy', () => {
    const result = orgMtlsSettingsSchema.safeParse({ expiredCertPolicy: 'revoke' });
    expect(result.success).toBe(false);
  });
});

// ============================================
// Helper Settings
// ============================================

describe('orgHelperSettingsSchema', () => {
  it('should accept enabled: true', () => {
    const result = orgHelperSettingsSchema.safeParse({ enabled: true });
    expect(result.success).toBe(true);
  });

  it('should accept enabled: false', () => {
    const result = orgHelperSettingsSchema.safeParse({ enabled: false });
    expect(result.success).toBe(true);
  });

  it('should apply default enabled: false', () => {
    const result = orgHelperSettingsSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(false);
    }
  });
});

// ============================================
// Log Forwarding Settings
// ============================================

describe('orgLogForwardingSettingsSchema', () => {
  it('should accept disabled config (minimal)', () => {
    const result = orgLogForwardingSettingsSchema.safeParse({
      enabled: false,
    });
    expect(result.success).toBe(true);
  });

  it('should accept disabled config without auth', () => {
    const result = orgLogForwardingSettingsSchema.safeParse({
      enabled: false,
      elasticsearchUrl: 'https://es.example.com',
    });
    expect(result.success).toBe(true);
  });

  it('should accept enabled config with API key auth', () => {
    const result = orgLogForwardingSettingsSchema.safeParse({
      enabled: true,
      elasticsearchUrl: 'https://es.example.com',
      elasticsearchApiKey: 'key123',
    });
    expect(result.success).toBe(true);
  });

  it('should accept enabled config with username/password auth', () => {
    const result = orgLogForwardingSettingsSchema.safeParse({
      enabled: true,
      elasticsearchUrl: 'https://es.example.com',
      elasticsearchUsername: 'admin',
      elasticsearchPassword: 's3cret',
    });
    expect(result.success).toBe(true);
  });

  it('should reject enabled without URL', () => {
    const result = orgLogForwardingSettingsSchema.safeParse({
      enabled: true,
      elasticsearchApiKey: 'key123',
    });
    expect(result.success).toBe(false);
  });

  it('should reject enabled with HTTP URL (requires HTTPS)', () => {
    const result = orgLogForwardingSettingsSchema.safeParse({
      enabled: true,
      elasticsearchUrl: 'http://es.example.com',
      elasticsearchApiKey: 'key123',
    });
    expect(result.success).toBe(false);
  });

  it('should reject enabled with invalid URL', () => {
    const result = orgLogForwardingSettingsSchema.safeParse({
      enabled: true,
      elasticsearchUrl: 'not-a-url',
      elasticsearchApiKey: 'key123',
    });
    expect(result.success).toBe(false);
  });

  it('should reject both API key and username/password auth', () => {
    const result = orgLogForwardingSettingsSchema.safeParse({
      enabled: true,
      elasticsearchUrl: 'https://es.example.com',
      elasticsearchApiKey: 'key123',
      elasticsearchUsername: 'admin',
      elasticsearchPassword: 'pass',
    });
    expect(result.success).toBe(false);
  });

  it('should reject enabled without any auth', () => {
    const result = orgLogForwardingSettingsSchema.safeParse({
      enabled: true,
      elasticsearchUrl: 'https://es.example.com',
    });
    expect(result.success).toBe(false);
  });

  it('should reject enabled with only username (missing password)', () => {
    const result = orgLogForwardingSettingsSchema.safeParse({
      enabled: true,
      elasticsearchUrl: 'https://es.example.com',
      elasticsearchUsername: 'admin',
    });
    expect(result.success).toBe(false);
  });

  it('should reject enabled with only password (missing username)', () => {
    const result = orgLogForwardingSettingsSchema.safeParse({
      enabled: true,
      elasticsearchUrl: 'https://es.example.com',
      elasticsearchPassword: 'pass',
    });
    expect(result.success).toBe(false);
  });

  it('should apply default indexPrefix', () => {
    const result = orgLogForwardingSettingsSchema.safeParse({
      enabled: false,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.indexPrefix).toBe('breeze-logs');
    }
  });

  it('should accept custom indexPrefix', () => {
    const result = orgLogForwardingSettingsSchema.safeParse({
      enabled: true,
      elasticsearchUrl: 'https://es.example.com',
      elasticsearchApiKey: 'key',
      indexPrefix: 'my-custom-prefix',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.indexPrefix).toBe('my-custom-prefix');
    }
  });

  it('should reject indexPrefix over 100 chars', () => {
    const result = orgLogForwardingSettingsSchema.safeParse({
      enabled: false,
      indexPrefix: 'x'.repeat(101),
    });
    expect(result.success).toBe(false);
  });
});

// ============================================
// Agent Validators
// ============================================

describe('agentEnrollSchema', () => {
  const validEnroll = {
    enrollmentKey: 'enroll-key-123',
    hostname: 'web-server-01',
    osType: 'windows' as const,
    osVersion: '10.0.19045',
    architecture: 'amd64',
  };

  it('should accept valid enrollment', () => {
    const result = agentEnrollSchema.safeParse(validEnroll);
    expect(result.success).toBe(true);
  });

  it('should accept enrollment with hardware info', () => {
    const result = agentEnrollSchema.safeParse({
      ...validEnroll,
      hardwareInfo: {
        cpuModel: 'Intel Core i7-12700',
        cpuCores: 12,
        ramTotalMb: 32768,
        serialNumber: 'SN123456',
        manufacturer: 'Dell',
        model: 'OptiPlex 7090',
      },
    });
    expect(result.success).toBe(true);
  });

  it('should accept enrollment with partial hardware info', () => {
    const result = agentEnrollSchema.safeParse({
      ...validEnroll,
      hardwareInfo: {
        cpuModel: 'AMD Ryzen 9',
      },
    });
    expect(result.success).toBe(true);
  });

  it('should accept all OS types', () => {
    const osTypes = ['windows', 'macos', 'linux'] as const;
    for (const osType of osTypes) {
      const result = agentEnrollSchema.safeParse({ ...validEnroll, osType });
      expect(result.success).toBe(true);
    }
  });

  it('should reject invalid OS type', () => {
    const result = agentEnrollSchema.safeParse({
      ...validEnroll,
      osType: 'freebsd',
    });
    expect(result.success).toBe(false);
  });

  it('should reject missing required fields', () => {
    expect(agentEnrollSchema.safeParse({}).success).toBe(false);
    expect(agentEnrollSchema.safeParse({ enrollmentKey: 'k' }).success).toBe(false);
  });
});

describe('commandResultSchema', () => {
  it('should accept completed result', () => {
    const result = commandResultSchema.safeParse({
      status: 'completed',
      exitCode: 0,
      stdout: 'Success',
      durationMs: 1500,
    });
    expect(result.success).toBe(true);
  });

  it('should accept failed result', () => {
    const result = commandResultSchema.safeParse({
      status: 'failed',
      exitCode: 1,
      stderr: 'Error occurred',
      durationMs: 500,
    });
    expect(result.success).toBe(true);
  });

  it('should accept timeout result', () => {
    const result = commandResultSchema.safeParse({
      status: 'timeout',
      durationMs: 300000,
    });
    expect(result.success).toBe(true);
  });

  it('should accept all status values', () => {
    const statuses = ['completed', 'failed', 'timeout'] as const;
    for (const status of statuses) {
      const result = commandResultSchema.safeParse({ status, durationMs: 100 });
      expect(result.success).toBe(true);
    }
  });

  it('should reject invalid status', () => {
    const result = commandResultSchema.safeParse({
      status: 'running',
      durationMs: 100,
    });
    expect(result.success).toBe(false);
  });

  it('should reject missing durationMs', () => {
    const result = commandResultSchema.safeParse({
      status: 'completed',
    });
    expect(result.success).toBe(false);
  });
});

// ============================================
// Audit Query
// ============================================

describe('auditQuerySchema', () => {
  it('should accept empty query', () => {
    const result = auditQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page).toBe(1);
      expect(result.data.limit).toBe(50);
    }
  });

  it('should accept full query', () => {
    const result = auditQuerySchema.safeParse({
      page: 2,
      limit: 25,
      from: '2026-01-01',
      to: '2026-03-01',
      actorId: VALID_UUID,
      actorType: 'user',
      action: 'device.update',
      resourceType: 'device',
      resourceId: VALID_UUID_2,
      result: 'success',
    });
    expect(result.success).toBe(true);
  });

  it('should accept all actorType values', () => {
    const types = ['user', 'api_key', 'agent', 'system'] as const;
    for (const actorType of types) {
      const result = auditQuerySchema.safeParse({ actorType });
      expect(result.success).toBe(true);
    }
  });

  it('should accept all result values', () => {
    const results = ['success', 'failure', 'denied'] as const;
    for (const r of results) {
      const result = auditQuerySchema.safeParse({ result: r });
      expect(result.success).toBe(true);
    }
  });

  it('should reject invalid actorType', () => {
    expect(auditQuerySchema.safeParse({ actorType: 'bot' }).success).toBe(false);
  });

  it('should reject invalid result', () => {
    expect(auditQuerySchema.safeParse({ result: 'error' }).success).toBe(false);
  });
});

// ============================================
// Config Policy
// ============================================

describe('createConfigPolicySchema', () => {
  it('should accept minimal config policy', () => {
    const result = createConfigPolicySchema.safeParse({ name: 'Default Policy' });
    expect(result.success).toBe(true);
  });

  it('should accept config policy with all fields', () => {
    const result = createConfigPolicySchema.safeParse({
      name: 'Default Policy',
      description: 'Applies to all devices',
      status: 'active',
      orgId: VALID_UUID,
    });
    expect(result.success).toBe(true);
  });

  it('should reject empty name', () => {
    expect(createConfigPolicySchema.safeParse({ name: '' }).success).toBe(false);
  });

  it('should reject name over 255 chars', () => {
    expect(
      createConfigPolicySchema.safeParse({ name: 'x'.repeat(256) }).success
    ).toBe(false);
  });

  it('should accept all status values', () => {
    const statuses = ['active', 'inactive', 'archived'] as const;
    for (const status of statuses) {
      expect(
        createConfigPolicySchema.safeParse({ name: 'Test', status }).success
      ).toBe(true);
    }
  });

  it('should reject invalid status', () => {
    expect(
      createConfigPolicySchema.safeParse({ name: 'Test', status: 'deleted' }).success
    ).toBe(false);
  });
});

describe('updateConfigPolicySchema', () => {
  it('should accept empty object', () => {
    expect(updateConfigPolicySchema.safeParse({}).success).toBe(true);
  });

  it('should accept partial update', () => {
    expect(
      updateConfigPolicySchema.safeParse({ name: 'Updated', status: 'archived' }).success
    ).toBe(true);
  });
});

describe('addFeatureLinkSchema', () => {
  it('should accept with featurePolicyId', () => {
    const result = addFeatureLinkSchema.safeParse({
      featureType: 'patch',
      featurePolicyId: VALID_UUID,
    });
    expect(result.success).toBe(true);
  });

  it('should accept with inlineSettings', () => {
    const result = addFeatureLinkSchema.safeParse({
      featureType: 'monitoring',
      inlineSettings: { interval: 60 },
    });
    expect(result.success).toBe(true);
  });

  it('should accept all feature types', () => {
    const featureTypes = [
      'patch', 'alert_rule', 'backup', 'security', 'monitoring',
      'maintenance', 'compliance', 'automation', 'event_log',
      'software_policy', 'sensitive_data', 'peripheral_control',
      'warranty', 'helper',
    ] as const;
    for (const featureType of featureTypes) {
      const result = addFeatureLinkSchema.safeParse({
        featureType,
        inlineSettings: {},
      });
      expect(result.success).toBe(true);
    }
  });

  it('should reject without featurePolicyId and inlineSettings', () => {
    const result = addFeatureLinkSchema.safeParse({
      featureType: 'patch',
    });
    expect(result.success).toBe(false);
  });

  it('should reject invalid feature type', () => {
    const result = addFeatureLinkSchema.safeParse({
      featureType: 'custom',
      inlineSettings: {},
    });
    expect(result.success).toBe(false);
  });
});

describe('eventLogInlineSettingsSchema', () => {
  it('should accept defaults', () => {
    const result = eventLogInlineSettingsSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.retentionDays).toBe(30);
      expect(result.data.maxEventsPerCycle).toBe(100);
      expect(result.data.minimumLevel).toBe('info');
      expect(result.data.collectionIntervalMinutes).toBe(5);
      expect(result.data.rateLimitPerHour).toBe(12000);
      expect(result.data.enableFullTextSearch).toBe(true);
      expect(result.data.enableCorrelation).toBe(true);
    }
  });

  it('should reject retentionDays below 7', () => {
    expect(eventLogInlineSettingsSchema.safeParse({ retentionDays: 6 }).success).toBe(false);
  });

  it('should reject retentionDays above 365', () => {
    expect(eventLogInlineSettingsSchema.safeParse({ retentionDays: 366 }).success).toBe(false);
  });

  it('should accept all collectCategories', () => {
    const result = eventLogInlineSettingsSchema.safeParse({
      collectCategories: ['security', 'hardware', 'application', 'system'],
    });
    expect(result.success).toBe(true);
  });

  it('should reject empty collectCategories', () => {
    const result = eventLogInlineSettingsSchema.safeParse({
      collectCategories: [],
    });
    expect(result.success).toBe(false);
  });

  it('should accept all minimumLevel values', () => {
    const levels = ['info', 'warning', 'error', 'critical'] as const;
    for (const level of levels) {
      expect(eventLogInlineSettingsSchema.safeParse({ minimumLevel: level }).success).toBe(true);
    }
  });
});

describe('sensitiveDataInlineSettingsSchema', () => {
  it('should accept defaults', () => {
    const result = sensitiveDataInlineSettingsSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.detectionClasses).toEqual(['credential']);
      expect(result.data.workers).toBe(4);
      expect(result.data.timeoutSeconds).toBe(300);
      expect(result.data.scheduleType).toBe('manual');
    }
  });

  it('should accept all detection classes', () => {
    const result = sensitiveDataInlineSettingsSchema.safeParse({
      detectionClasses: ['credential', 'pci', 'phi', 'pii', 'financial'],
    });
    expect(result.success).toBe(true);
  });

  it('should reject empty detectionClasses', () => {
    const result = sensitiveDataInlineSettingsSchema.safeParse({
      detectionClasses: [],
    });
    expect(result.success).toBe(false);
  });

  it('should accept all scheduleTypes', () => {
    const types = ['manual', 'interval', 'cron'] as const;
    for (const type of types) {
      expect(sensitiveDataInlineSettingsSchema.safeParse({ scheduleType: type }).success).toBe(true);
    }
  });

  it('should reject workers below 1', () => {
    expect(sensitiveDataInlineSettingsSchema.safeParse({ workers: 0 }).success).toBe(false);
  });

  it('should reject workers above 32', () => {
    expect(sensitiveDataInlineSettingsSchema.safeParse({ workers: 33 }).success).toBe(false);
  });

  it('should reject timeoutSeconds below 5', () => {
    expect(sensitiveDataInlineSettingsSchema.safeParse({ timeoutSeconds: 4 }).success).toBe(false);
  });

  it('should reject timeoutSeconds above 1800', () => {
    expect(sensitiveDataInlineSettingsSchema.safeParse({ timeoutSeconds: 1801 }).success).toBe(false);
  });

  it('should reject maxFileSizeBytes below 1024', () => {
    expect(sensitiveDataInlineSettingsSchema.safeParse({ maxFileSizeBytes: 1023 }).success).toBe(false);
  });

  it('should reject maxFileSizeBytes above 1073741824', () => {
    expect(sensitiveDataInlineSettingsSchema.safeParse({ maxFileSizeBytes: 1073741825 }).success).toBe(false);
  });
});

describe('monitoringInlineSettingsSchema', () => {
  it('should accept defaults', () => {
    const result = monitoringInlineSettingsSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.checkIntervalSeconds).toBe(60);
      expect(result.data.watches).toEqual([]);
      expect(result.data.eventLogAlerts).toEqual([]);
      expect(result.data.alertRules).toEqual([]);
    }
  });

  it('should accept watch entry', () => {
    const result = monitoringInlineSettingsSchema.safeParse({
      watches: [
        {
          watchType: 'service',
          name: 'wuauserv',
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('should accept process watch with thresholds', () => {
    const result = monitoringInlineSettingsSchema.safeParse({
      watches: [
        {
          watchType: 'process',
          name: 'nginx',
          cpuThresholdPercent: 80,
          memoryThresholdMb: 512,
          autoRestart: true,
          maxRestartAttempts: 5,
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('should reject checkIntervalSeconds below 10', () => {
    expect(
      monitoringInlineSettingsSchema.safeParse({ checkIntervalSeconds: 9 }).success
    ).toBe(false);
  });

  it('should reject checkIntervalSeconds above 3600', () => {
    expect(
      monitoringInlineSettingsSchema.safeParse({ checkIntervalSeconds: 3601 }).success
    ).toBe(false);
  });

  it('should reject watches over 200', () => {
    const watches = Array.from({ length: 201 }, (_, i) => ({
      watchType: 'service' as const,
      name: `svc${i}`,
    }));
    expect(
      monitoringInlineSettingsSchema.safeParse({ watches }).success
    ).toBe(false);
  });

  it('should accept event log alert', () => {
    const result = monitoringInlineSettingsSchema.safeParse({
      eventLogAlerts: [
        {
          name: 'Security Alert',
          category: 'security',
          level: 'critical',
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('should reject eventLogAlerts over 50', () => {
    const alerts = Array.from({ length: 51 }, (_, i) => ({
      name: `alert${i}`,
      category: 'security' as const,
      level: 'error' as const,
    }));
    expect(
      monitoringInlineSettingsSchema.safeParse({ eventLogAlerts: alerts }).success
    ).toBe(false);
  });

  it('should accept alert rule', () => {
    const result = monitoringInlineSettingsSchema.safeParse({
      alertRules: [
        {
          name: 'CPU Alert',
          conditions: [{ type: 'metric', metric: 'cpu', operator: 'gt', value: 90 }],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('should reject alertRules with empty conditions', () => {
    const result = monitoringInlineSettingsSchema.safeParse({
      alertRules: [{ name: 'Test', conditions: [] }],
    });
    expect(result.success).toBe(false);
  });

  it('should reject alertRules over 100', () => {
    const rules = Array.from({ length: 101 }, (_, i) => ({
      name: `rule${i}`,
      conditions: [{ type: 'metric' as const }],
    }));
    expect(
      monitoringInlineSettingsSchema.safeParse({ alertRules: rules }).success
    ).toBe(false);
  });
});

describe('updateFeatureLinkSchema', () => {
  it('should accept empty object', () => {
    expect(updateFeatureLinkSchema.safeParse({}).success).toBe(true);
  });

  it('should accept nullable featurePolicyId', () => {
    expect(
      updateFeatureLinkSchema.safeParse({ featurePolicyId: null }).success
    ).toBe(true);
  });

  it('should accept nullable inlineSettings', () => {
    expect(
      updateFeatureLinkSchema.safeParse({ inlineSettings: null }).success
    ).toBe(true);
  });

  it('should accept valid UUID for featurePolicyId', () => {
    expect(
      updateFeatureLinkSchema.safeParse({ featurePolicyId: VALID_UUID }).success
    ).toBe(true);
  });
});

describe('assignPolicySchema', () => {
  it('should accept valid assignment', () => {
    const result = assignPolicySchema.safeParse({
      level: 'organization',
      targetId: VALID_UUID,
    });
    expect(result.success).toBe(true);
  });

  it('should accept all levels', () => {
    const levels = ['partner', 'organization', 'site', 'device_group', 'device'] as const;
    for (const level of levels) {
      expect(
        assignPolicySchema.safeParse({ level, targetId: VALID_UUID }).success
      ).toBe(true);
    }
  });

  it('should accept optional priority', () => {
    const result = assignPolicySchema.safeParse({
      level: 'device',
      targetId: VALID_UUID,
      priority: 100,
    });
    expect(result.success).toBe(true);
  });

  it('should reject priority over 1000', () => {
    const result = assignPolicySchema.safeParse({
      level: 'device',
      targetId: VALID_UUID,
      priority: 1001,
    });
    expect(result.success).toBe(false);
  });

  it('should reject negative priority', () => {
    const result = assignPolicySchema.safeParse({
      level: 'device',
      targetId: VALID_UUID,
      priority: -1,
    });
    expect(result.success).toBe(false);
  });

  it('should accept roleFilter with device roles', () => {
    const result = assignPolicySchema.safeParse({
      level: 'organization',
      targetId: VALID_UUID,
      roleFilter: ['server', 'workstation'],
    });
    expect(result.success).toBe(true);
  });

  it('should accept osFilter', () => {
    const result = assignPolicySchema.safeParse({
      level: 'site',
      targetId: VALID_UUID,
      osFilter: ['windows', 'linux'],
    });
    expect(result.success).toBe(true);
  });

  it('should reject invalid level', () => {
    expect(
      assignPolicySchema.safeParse({ level: 'global', targetId: VALID_UUID }).success
    ).toBe(false);
  });
});

describe('diffSchema', () => {
  it('should accept add entries', () => {
    const result = diffSchema.safeParse({
      add: [
        {
          configPolicyId: VALID_UUID,
          level: 'organization',
          targetId: VALID_UUID_2,
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('should accept remove entries', () => {
    const result = diffSchema.safeParse({
      remove: [VALID_UUID],
    });
    expect(result.success).toBe(true);
  });

  it('should accept both add and remove', () => {
    const result = diffSchema.safeParse({
      add: [
        {
          configPolicyId: VALID_UUID,
          level: 'site',
          targetId: VALID_UUID_2,
          priority: 10,
        },
      ],
      remove: [VALID_UUID],
    });
    expect(result.success).toBe(true);
  });

  it('should accept empty object', () => {
    expect(diffSchema.safeParse({}).success).toBe(true);
  });
});

describe('listConfigPoliciesSchema', () => {
  it('should accept empty query', () => {
    expect(listConfigPoliciesSchema.safeParse({}).success).toBe(true);
  });

  it('should accept all parameters', () => {
    const result = listConfigPoliciesSchema.safeParse({
      page: '1',
      limit: '25',
      status: 'active',
      search: 'default',
      orgId: VALID_UUID,
    });
    expect(result.success).toBe(true);
  });

  it('should reject invalid status', () => {
    expect(
      listConfigPoliciesSchema.safeParse({ status: 'deleted' }).success
    ).toBe(false);
  });
});

describe('targetQuerySchema', () => {
  it('should accept valid query', () => {
    const result = targetQuerySchema.safeParse({
      level: 'device',
      targetId: VALID_UUID,
    });
    expect(result.success).toBe(true);
  });

  it('should reject missing level', () => {
    expect(targetQuerySchema.safeParse({ targetId: VALID_UUID }).success).toBe(false);
  });

  it('should reject missing targetId', () => {
    expect(targetQuerySchema.safeParse({ level: 'device' }).success).toBe(false);
  });
});

// ============================================
// Config Policy Param Schemas
// ============================================

describe('configPolicyIdParamSchema', () => {
  it('should accept valid UUID', () => {
    expect(configPolicyIdParamSchema.safeParse({ id: VALID_UUID }).success).toBe(true);
  });

  it('should reject invalid UUID', () => {
    expect(configPolicyIdParamSchema.safeParse({ id: 'bad' }).success).toBe(false);
  });
});

describe('configPolicyLinkIdParamSchema', () => {
  it('should accept valid UUIDs', () => {
    expect(
      configPolicyLinkIdParamSchema.safeParse({ id: VALID_UUID, linkId: VALID_UUID_2 }).success
    ).toBe(true);
  });

  it('should reject missing linkId', () => {
    expect(
      configPolicyLinkIdParamSchema.safeParse({ id: VALID_UUID }).success
    ).toBe(false);
  });
});

describe('configPolicyAssignmentIdParamSchema', () => {
  it('should accept valid UUIDs', () => {
    expect(
      configPolicyAssignmentIdParamSchema.safeParse({ id: VALID_UUID, aid: VALID_UUID_2 }).success
    ).toBe(true);
  });
});

describe('configPolicyDeviceIdParamSchema', () => {
  it('should accept valid UUID', () => {
    expect(
      configPolicyDeviceIdParamSchema.safeParse({ deviceId: VALID_UUID }).success
    ).toBe(true);
  });

  it('should reject invalid UUID', () => {
    expect(
      configPolicyDeviceIdParamSchema.safeParse({ deviceId: 'bad' }).success
    ).toBe(false);
  });
});
