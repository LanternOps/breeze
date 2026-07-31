import { describe, expect, it } from 'vitest';
import { alertRuleConditionSchema, alertRuleInlineSettingsSchema, monitoringInlineSettingsSchema } from './index';

describe('alertRuleConditionSchema', () => {
  it('accepts a metric condition', () => {
    const r = alertRuleConditionSchema.safeParse({ type: 'metric', metric: 'cpu', operator: 'gt', value: 85 });
    expect(r.success).toBe(true);
  });

  it('accepts every metric name the evaluator resolves, including the aliases', () => {
    // apps/api/src/services/alertConditions/utils.ts METRIC_NAME_MAP. AI-written
    // and pre-consolidation rows use the *Percent aliases; a narrower enum here
    // hard-400s a save of an Alerts tab that merely CONTAINS such a row.
    const names = ['cpu', 'cpuPercent', 'ram', 'ramPercent', 'memory', 'disk', 'diskPercent', 'processCount', 'processes'];
    for (const metric of names) {
      const r = alertRuleConditionSchema.safeParse({ type: 'metric', metric, operator: 'gt', value: 85 });
      expect(r.success, `metric ${metric}`).toBe(true);
    }
    expect(alertRuleConditionSchema.safeParse({ type: 'metric', metric: 'network', operator: 'gt', value: 85 }).success).toBe(false);
  });

  it('round-trips durationMinutes on a metric condition (the evaluator honours it)', () => {
    const r = alertRuleConditionSchema.safeParse({ type: 'metric', metric: 'cpuPercent', operator: 'gt', value: 85, durationMinutes: 15 });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toMatchObject({ metric: 'cpuPercent', durationMinutes: 15 });
  });

  it('no longer carries a `duration` (seconds) field on metric conditions', () => {
    // Nothing in the metric evaluator ever read it; it is stripped, not stored.
    const r = alertRuleConditionSchema.safeParse({ type: 'metric', metric: 'cpu', operator: 'gt', value: 85, duration: 300 });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).not.toHaveProperty('duration');
  });

  it('accepts an offline condition and canonicalizes legacy status', () => {
    expect(alertRuleConditionSchema.safeParse({ type: 'offline', durationMinutes: 10 }).success).toBe(true);
    const legacy = alertRuleConditionSchema.safeParse({ type: 'status', durationMinutes: 10 });
    expect(legacy.success).toBe(true);
    if (legacy.success) expect(legacy.data.type).toBe('offline');
  });

  it('folds a legacy offline `duration` into durationMinutes instead of dropping it', () => {
    // handlers/offline.ts reads `duration` for rows the old editor saved as
    // {type:'status', duration:N}; stripping it would reset them to the 5-min default.
    const r = alertRuleConditionSchema.safeParse({ type: 'status', duration: 30 });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data).toMatchObject({ type: 'offline', durationMinutes: 30 });
      expect(r.data).not.toHaveProperty('duration');
    }
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

  it('accepts every operator the threshold evaluator validates, including neq', () => {
    // apps/api/src/services/alertConditions/handlers/threshold.ts validates
    // gt/gte/lt/lte/eq/neq. The AlertRuleTab editor offers all six, so any one
    // of them missing here is a hard 400 on a rule the evaluator would have run.
    for (const operator of ['gt', 'gte', 'lt', 'lte', 'eq', 'neq'] as const) {
      const r = alertRuleConditionSchema.safeParse({ type: 'metric', metric: 'cpu', operator, value: 85 });
      expect(r.success, `operator ${operator}`).toBe(true);
    }
    expect(alertRuleConditionSchema.safeParse({ type: 'metric', metric: 'cpu', operator: 'contains', value: 85 }).success).toBe(false);
  });

  it('rejects a metric condition with no metric name', () => {
    expect(alertRuleConditionSchema.safeParse({ type: 'metric', operator: 'gt', value: 85 }).success).toBe(false);
  });

  it('accepts `threshold` as an alias of `metric` and canonicalizes it', () => {
    // handlers/threshold.ts declares `type: 'threshold'` with aliases ['metric'],
    // and the pre-consolidation AI tool description advertised it, so rows exist.
    const r = alertRuleConditionSchema.safeParse({ type: 'threshold', metric: 'cpu', operator: 'gt', value: 85 });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.type).toBe('metric');
  });

  it('reports the offending field on a threshold-typed condition, not a bare union error', () => {
    const r = alertRuleConditionSchema.safeParse({ type: 'threshold', metric: 'bogus', operator: 'gt', value: 85 });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.join('.') === 'metric')).toBe(true);
      expect(JSON.stringify(r.error.issues)).not.toContain('Invalid input');
    }
  });

  it('names the accepted condition types when `type` is unrecognised', () => {
    const r = alertRuleConditionSchema.safeParse({ type: 'network', metric: 'network', operator: 'gt', value: 85 });
    expect(r.success).toBe(false);
    if (!r.success) expect(JSON.stringify(r.error.issues)).toContain('metric');
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
