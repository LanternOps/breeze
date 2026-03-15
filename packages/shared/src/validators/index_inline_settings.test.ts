import { describe, it, expect } from 'vitest';
import {
  eventLogInlineSettingsSchema,
  sensitiveDataInlineSettingsSchema,
  monitoringInlineSettingsSchema,
} from './index';

// ============================================
// Event Log Inline Settings
// ============================================

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

// ============================================
// Sensitive Data Inline Settings
// ============================================

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

// ============================================
// Monitoring Inline Settings
// ============================================

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
