import { describe, it, expect } from 'vitest';
import {
  // Device Roles
  DEVICE_ROLES,
  // Auth
  forgotPasswordSchema,
  refreshTokenSchema,
  // Automation
  automationTriggerSchema,
  createAutomationSchema,
  createPolicySchema,
} from './index';

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';

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
    if (result.success && result.data.type === 'schedule') {
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

  it('should reject webhook trigger without a signing secret', () => {
    const result = automationTriggerSchema.safeParse({
      type: 'webhook',
    });
    expect(result.success).toBe(false);
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
