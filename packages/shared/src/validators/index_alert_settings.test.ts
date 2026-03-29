import { describe, it, expect } from 'vitest';
import {
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
} from './index';

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';
const VALID_UUID_2 = '660e8400-e29b-41d4-a716-446655440001';

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
