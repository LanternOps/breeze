import { describe, expect, it } from 'vitest';
import { alertRuleConditionSchema, alertRuleInlineSettingsSchema, monitoringInlineSettingsSchema } from './index';

describe('alertRuleConditionSchema', () => {
  it('accepts a metric condition', () => {
    const r = alertRuleConditionSchema.safeParse({ type: 'metric', metric: 'cpu', operator: 'gt', value: 85, duration: 300 });
    expect(r.success).toBe(true);
  });

  it('accepts an offline condition and canonicalizes legacy status', () => {
    expect(alertRuleConditionSchema.safeParse({ type: 'offline', durationMinutes: 10 }).success).toBe(true);
    const legacy = alertRuleConditionSchema.safeParse({ type: 'status', durationMinutes: 10 });
    expect(legacy.success).toBe(true);
    if (legacy.success) expect(legacy.data.type).toBe('offline');
  });

  it('accepts an event_log condition', () => {
    const r = alertRuleConditionSchema.safeParse({
      type: 'event_log', category: 'system', level: 'error',
      sourcePattern: 'disk', countThreshold: 3, windowMinutes: 15,
    });
    expect(r.success).toBe(true);
  });

  it('rejects custom (no evaluator handler) and unreleased extended types', () => {
    expect(alertRuleConditionSchema.safeParse({ type: 'custom', customCondition: 'x' }).success).toBe(false);
    expect(alertRuleConditionSchema.safeParse({ type: 'bandwidth_high', value: 100 }).success).toBe(false);
  });

  it('rejects a metric condition with no metric name', () => {
    expect(alertRuleConditionSchema.safeParse({ type: 'metric', operator: 'gt', value: 85 }).success).toBe(false);
  });
});

describe('alertRuleInlineSettingsSchema', () => {
  it('parses items with defaults', () => {
    const r = alertRuleInlineSettingsSchema.parse({
      items: [{ name: 'High CPU', conditions: [{ type: 'metric', metric: 'cpu', operator: 'gt', value: 85 }] }],
    });
    expect(r.items[0]!.severity).toBe('medium');
    expect(r.items[0]!.cooldownMinutes).toBe(5);
  });
});

describe('monitoringInlineSettingsSchema (post-consolidation)', () => {
  it('rejects non-empty legacy alertRules with a pointer message', () => {
    const r = monitoringInlineSettingsSchema.safeParse({
      checkIntervalSeconds: 60, watches: [],
      alertRules: [{ name: 'x', conditions: [{ type: 'metric', metric: 'cpu', operator: 'gt', value: 80 }] }],
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(JSON.stringify(r.error.issues)).toContain('Alerts feature');
  });

  it('rejects non-empty legacy eventLogAlerts', () => {
    const r = monitoringInlineSettingsSchema.safeParse({
      eventLogAlerts: [{ name: 'x', category: 'system', level: 'error' }],
    });
    expect(r.success).toBe(false);
  });

  it('accepts empty/absent legacy arrays (stale clients sending [])', () => {
    expect(monitoringInlineSettingsSchema.safeParse({ checkIntervalSeconds: 60, watches: [], alertRules: [], eventLogAlerts: [] }).success).toBe(true);
    expect(monitoringInlineSettingsSchema.safeParse({ watches: [{ watchType: 'service', name: 'MSSQLSERVER' }] }).success).toBe(true);
  });
});
