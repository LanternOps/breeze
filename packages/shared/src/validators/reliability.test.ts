import { describe, it, expect } from 'vitest';
import {
  reliabilityCrashEventSchema,
  reliabilityAppHangSchema,
  reliabilityServiceFailureSchema,
  reliabilityHardwareErrorSchema,
  reliabilityMetricsSchema,
} from './reliability';

const VALID_TIMESTAMP = '2026-03-01T12:00:00Z';

describe('reliabilityCrashEventSchema', () => {
  it('should accept valid crash event', () => {
    const result = reliabilityCrashEventSchema.safeParse({
      type: 'bsod',
      timestamp: VALID_TIMESTAMP,
    });
    expect(result.success).toBe(true);
  });

  it('should accept all crash event types', () => {
    const types = ['bsod', 'kernel_panic', 'system_crash', 'oom_kill', 'unknown'] as const;
    for (const type of types) {
      const result = reliabilityCrashEventSchema.safeParse({
        type,
        timestamp: VALID_TIMESTAMP,
      });
      expect(result.success).toBe(true);
    }
  });

  it('should accept crash event with optional details', () => {
    const result = reliabilityCrashEventSchema.safeParse({
      type: 'bsod',
      timestamp: VALID_TIMESTAMP,
      details: { bugcheck: '0x0000007E', driver: 'ntoskrnl.exe' },
    });
    expect(result.success).toBe(true);
  });

  it('should reject invalid crash type', () => {
    const result = reliabilityCrashEventSchema.safeParse({
      type: 'segfault',
      timestamp: VALID_TIMESTAMP,
    });
    expect(result.success).toBe(false);
  });

  it('should reject invalid timestamp', () => {
    const result = reliabilityCrashEventSchema.safeParse({
      type: 'bsod',
      timestamp: 'not-a-date',
    });
    expect(result.success).toBe(false);
  });

  it('should reject missing type', () => {
    const result = reliabilityCrashEventSchema.safeParse({
      timestamp: VALID_TIMESTAMP,
    });
    expect(result.success).toBe(false);
  });

  it('should reject missing timestamp', () => {
    const result = reliabilityCrashEventSchema.safeParse({
      type: 'bsod',
    });
    expect(result.success).toBe(false);
  });
});

describe('reliabilityAppHangSchema', () => {
  it('should accept valid app hang', () => {
    const result = reliabilityAppHangSchema.safeParse({
      processName: 'explorer.exe',
      timestamp: VALID_TIMESTAMP,
      duration: 30,
      resolved: true,
    });
    expect(result.success).toBe(true);
  });

  it('should accept zero duration', () => {
    const result = reliabilityAppHangSchema.safeParse({
      processName: 'app.exe',
      timestamp: VALID_TIMESTAMP,
      duration: 0,
      resolved: false,
    });
    expect(result.success).toBe(true);
  });

  it('should accept max duration (86400)', () => {
    const result = reliabilityAppHangSchema.safeParse({
      processName: 'app.exe',
      timestamp: VALID_TIMESTAMP,
      duration: 86400,
      resolved: false,
    });
    expect(result.success).toBe(true);
  });

  it('should reject duration over 86400', () => {
    const result = reliabilityAppHangSchema.safeParse({
      processName: 'app.exe',
      timestamp: VALID_TIMESTAMP,
      duration: 86401,
      resolved: false,
    });
    expect(result.success).toBe(false);
  });

  it('should reject negative duration', () => {
    const result = reliabilityAppHangSchema.safeParse({
      processName: 'app.exe',
      timestamp: VALID_TIMESTAMP,
      duration: -1,
      resolved: false,
    });
    expect(result.success).toBe(false);
  });

  it('should reject fractional duration', () => {
    const result = reliabilityAppHangSchema.safeParse({
      processName: 'app.exe',
      timestamp: VALID_TIMESTAMP,
      duration: 30.5,
      resolved: false,
    });
    expect(result.success).toBe(false);
  });

  it('should reject empty processName', () => {
    const result = reliabilityAppHangSchema.safeParse({
      processName: '',
      timestamp: VALID_TIMESTAMP,
      duration: 30,
      resolved: true,
    });
    expect(result.success).toBe(false);
  });

  it('should reject processName over 255 chars', () => {
    const result = reliabilityAppHangSchema.safeParse({
      processName: 'x'.repeat(256),
      timestamp: VALID_TIMESTAMP,
      duration: 30,
      resolved: true,
    });
    expect(result.success).toBe(false);
  });

  it('should reject missing fields', () => {
    expect(reliabilityAppHangSchema.safeParse({}).success).toBe(false);
    expect(
      reliabilityAppHangSchema.safeParse({
        processName: 'app.exe',
        timestamp: VALID_TIMESTAMP,
        duration: 30,
        // missing resolved
      }).success
    ).toBe(false);
  });
});

describe('reliabilityServiceFailureSchema', () => {
  it('should accept valid service failure', () => {
    const result = reliabilityServiceFailureSchema.safeParse({
      serviceName: 'wuauserv',
      timestamp: VALID_TIMESTAMP,
      recovered: true,
    });
    expect(result.success).toBe(true);
  });

  it('should accept service failure with optional errorCode', () => {
    const result = reliabilityServiceFailureSchema.safeParse({
      serviceName: 'spooler',
      timestamp: VALID_TIMESTAMP,
      errorCode: '0x800F0831',
      recovered: false,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.errorCode).toBe('0x800F0831');
    }
  });

  it('should accept service failure without errorCode', () => {
    const result = reliabilityServiceFailureSchema.safeParse({
      serviceName: 'spooler',
      timestamp: VALID_TIMESTAMP,
      recovered: false,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.errorCode).toBeUndefined();
    }
  });

  it('should reject empty serviceName', () => {
    const result = reliabilityServiceFailureSchema.safeParse({
      serviceName: '',
      timestamp: VALID_TIMESTAMP,
      recovered: true,
    });
    expect(result.success).toBe(false);
  });

  it('should reject serviceName over 255 chars', () => {
    const result = reliabilityServiceFailureSchema.safeParse({
      serviceName: 'x'.repeat(256),
      timestamp: VALID_TIMESTAMP,
      recovered: true,
    });
    expect(result.success).toBe(false);
  });

  it('should reject errorCode over 100 chars', () => {
    const result = reliabilityServiceFailureSchema.safeParse({
      serviceName: 'test',
      timestamp: VALID_TIMESTAMP,
      errorCode: 'e'.repeat(101),
      recovered: true,
    });
    expect(result.success).toBe(false);
  });
});

describe('reliabilityHardwareErrorSchema', () => {
  it('should accept valid hardware error', () => {
    const result = reliabilityHardwareErrorSchema.safeParse({
      type: 'disk',
      severity: 'error',
      timestamp: VALID_TIMESTAMP,
      source: 'smartctl',
    });
    expect(result.success).toBe(true);
  });

  it('should accept all hardware error types', () => {
    const types = ['mce', 'disk', 'memory', 'unknown'] as const;
    for (const type of types) {
      const result = reliabilityHardwareErrorSchema.safeParse({
        type,
        severity: 'warning',
        timestamp: VALID_TIMESTAMP,
        source: 'hwmon',
      });
      expect(result.success).toBe(true);
    }
  });

  it('should accept all severity levels', () => {
    const severities = ['critical', 'error', 'warning'] as const;
    for (const severity of severities) {
      const result = reliabilityHardwareErrorSchema.safeParse({
        type: 'mce',
        severity,
        timestamp: VALID_TIMESTAMP,
        source: 'kernel',
      });
      expect(result.success).toBe(true);
    }
  });

  it('should accept optional eventId', () => {
    const result = reliabilityHardwareErrorSchema.safeParse({
      type: 'memory',
      severity: 'critical',
      timestamp: VALID_TIMESTAMP,
      source: 'mcelog',
      eventId: 'MCE-2026-001',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.eventId).toBe('MCE-2026-001');
    }
  });

  it('should reject invalid type', () => {
    const result = reliabilityHardwareErrorSchema.safeParse({
      type: 'cpu',
      severity: 'error',
      timestamp: VALID_TIMESTAMP,
      source: 'test',
    });
    expect(result.success).toBe(false);
  });

  it('should reject invalid severity', () => {
    const result = reliabilityHardwareErrorSchema.safeParse({
      type: 'disk',
      severity: 'info',
      timestamp: VALID_TIMESTAMP,
      source: 'test',
    });
    expect(result.success).toBe(false);
  });

  it('should reject empty source', () => {
    const result = reliabilityHardwareErrorSchema.safeParse({
      type: 'disk',
      severity: 'error',
      timestamp: VALID_TIMESTAMP,
      source: '',
    });
    expect(result.success).toBe(false);
  });

  it('should reject source over 255 chars', () => {
    const result = reliabilityHardwareErrorSchema.safeParse({
      type: 'disk',
      severity: 'error',
      timestamp: VALID_TIMESTAMP,
      source: 'x'.repeat(256),
    });
    expect(result.success).toBe(false);
  });

  it('should reject eventId over 100 chars', () => {
    const result = reliabilityHardwareErrorSchema.safeParse({
      type: 'disk',
      severity: 'error',
      timestamp: VALID_TIMESTAMP,
      source: 'test',
      eventId: 'e'.repeat(101),
    });
    expect(result.success).toBe(false);
  });
});

describe('reliabilityMetricsSchema', () => {
  const validMetrics = {
    uptimeSeconds: 86400,
    bootTime: VALID_TIMESTAMP,
  };

  it('should accept minimal valid metrics (defaults applied)', () => {
    const result = reliabilityMetricsSchema.safeParse(validMetrics);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.crashEvents).toEqual([]);
      expect(result.data.appHangs).toEqual([]);
      expect(result.data.serviceFailures).toEqual([]);
      expect(result.data.hardwareErrors).toEqual([]);
    }
  });

  it('should accept full metrics payload', () => {
    const result = reliabilityMetricsSchema.safeParse({
      ...validMetrics,
      crashEvents: [
        { type: 'bsod', timestamp: VALID_TIMESTAMP },
      ],
      appHangs: [
        { processName: 'chrome.exe', timestamp: VALID_TIMESTAMP, duration: 15, resolved: true },
      ],
      serviceFailures: [
        { serviceName: 'wuauserv', timestamp: VALID_TIMESTAMP, recovered: true },
      ],
      hardwareErrors: [
        { type: 'disk', severity: 'warning', timestamp: VALID_TIMESTAMP, source: 'smartctl' },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('should reject negative uptimeSeconds', () => {
    const result = reliabilityMetricsSchema.safeParse({
      ...validMetrics,
      uptimeSeconds: -1,
    });
    expect(result.success).toBe(false);
  });

  it('should reject fractional uptimeSeconds', () => {
    const result = reliabilityMetricsSchema.safeParse({
      ...validMetrics,
      uptimeSeconds: 100.5,
    });
    expect(result.success).toBe(false);
  });

  it('should accept zero uptimeSeconds', () => {
    const result = reliabilityMetricsSchema.safeParse({
      ...validMetrics,
      uptimeSeconds: 0,
    });
    expect(result.success).toBe(true);
  });

  it('should reject invalid bootTime', () => {
    const result = reliabilityMetricsSchema.safeParse({
      ...validMetrics,
      bootTime: 'invalid',
    });
    expect(result.success).toBe(false);
  });

  it('should reject crashEvents over 500', () => {
    const events = Array.from({ length: 501 }, () => ({
      type: 'bsod' as const,
      timestamp: VALID_TIMESTAMP,
    }));
    const result = reliabilityMetricsSchema.safeParse({
      ...validMetrics,
      crashEvents: events,
    });
    expect(result.success).toBe(false);
  });

  it('should accept exactly 500 crash events', () => {
    const events = Array.from({ length: 500 }, () => ({
      type: 'bsod' as const,
      timestamp: VALID_TIMESTAMP,
    }));
    const result = reliabilityMetricsSchema.safeParse({
      ...validMetrics,
      crashEvents: events,
    });
    expect(result.success).toBe(true);
  });

  it('should reject appHangs over 1000', () => {
    const hangs = Array.from({ length: 1001 }, () => ({
      processName: 'app.exe',
      timestamp: VALID_TIMESTAMP,
      duration: 10,
      resolved: true,
    }));
    const result = reliabilityMetricsSchema.safeParse({
      ...validMetrics,
      appHangs: hangs,
    });
    expect(result.success).toBe(false);
  });

  it('should reject serviceFailures over 1000', () => {
    const failures = Array.from({ length: 1001 }, () => ({
      serviceName: 'svc',
      timestamp: VALID_TIMESTAMP,
      recovered: true,
    }));
    const result = reliabilityMetricsSchema.safeParse({
      ...validMetrics,
      serviceFailures: failures,
    });
    expect(result.success).toBe(false);
  });

  it('should reject hardwareErrors over 1000', () => {
    const errors = Array.from({ length: 1001 }, () => ({
      type: 'disk' as const,
      severity: 'error' as const,
      timestamp: VALID_TIMESTAMP,
      source: 'test',
    }));
    const result = reliabilityMetricsSchema.safeParse({
      ...validMetrics,
      hardwareErrors: errors,
    });
    expect(result.success).toBe(false);
  });

  it('should pass through unknown properties (passthrough)', () => {
    const result = reliabilityMetricsSchema.safeParse({
      ...validMetrics,
      customField: 'hello',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).customField).toBe('hello');
    }
  });

  it('should reject missing required fields', () => {
    expect(reliabilityMetricsSchema.safeParse({}).success).toBe(false);
    expect(
      reliabilityMetricsSchema.safeParse({ uptimeSeconds: 100 }).success
    ).toBe(false);
    expect(
      reliabilityMetricsSchema.safeParse({ bootTime: VALID_TIMESTAMP }).success
    ).toBe(false);
  });
});
