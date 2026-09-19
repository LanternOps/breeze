import { describe, expect, it } from 'vitest';
import { alertRuleItemSchema, monitoringInlineSettingsSchema } from './index';

// #5650 W03: `rationale` is an optional free-text explanation an AI-generated
// (or hand-authored) alert rule / monitoring watch carries alongside its
// mechanical fields — why this rule/watch exists, not what it does. Threaded
// through config_policy_alert_rules.rationale and
// config_policy_monitoring_watches.rationale.

const BASE_ALERT_ITEM = {
  name: 'High CPU',
  conditions: [{ type: 'metric', metric: 'cpu', operator: 'gt', value: 85 }],
};

const BASE_WATCH = {
  watchType: 'service' as const,
  name: 'wuauserv',
};

describe('alertRuleItemSchema rationale', () => {
  it('is omitted by default (parses to undefined, not defaulted)', () => {
    const r = alertRuleItemSchema.safeParse(BASE_ALERT_ITEM);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.rationale).toBeUndefined();
  });

  it('accepts null (round-tripped from a row with no rationale set)', () => {
    const r = alertRuleItemSchema.safeParse({ ...BASE_ALERT_ITEM, rationale: null });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.rationale).toBeNull();
  });

  it('trims surrounding whitespace', () => {
    const r = alertRuleItemSchema.safeParse({ ...BASE_ALERT_ITEM, rationale: '  why  ' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.rationale).toBe('why');
  });

  it('rejects a rationale over 2000 characters', () => {
    const r = alertRuleItemSchema.safeParse({ ...BASE_ALERT_ITEM, rationale: 'x'.repeat(2001) });
    expect(r.success).toBe(false);
  });

  it('accepts a rationale at exactly 2000 characters', () => {
    const r = alertRuleItemSchema.safeParse({ ...BASE_ALERT_ITEM, rationale: 'x'.repeat(2000) });
    expect(r.success).toBe(true);
  });
});

describe('monitoringInlineSettingsSchema watch rationale', () => {
  it('is omitted by default (parses to undefined, not defaulted)', () => {
    const r = monitoringInlineSettingsSchema.safeParse({ watches: [BASE_WATCH] });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.watches[0]?.rationale).toBeUndefined();
  });

  it('accepts null (round-tripped from a row with no rationale set)', () => {
    const r = monitoringInlineSettingsSchema.safeParse({
      watches: [{ ...BASE_WATCH, rationale: null }],
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.watches[0]?.rationale).toBeNull();
  });

  it('trims surrounding whitespace', () => {
    const r = monitoringInlineSettingsSchema.safeParse({
      watches: [{ ...BASE_WATCH, rationale: '  why  ' }],
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.watches[0]?.rationale).toBe('why');
  });

  it('rejects a rationale over 2000 characters', () => {
    const r = monitoringInlineSettingsSchema.safeParse({
      watches: [{ ...BASE_WATCH, rationale: 'x'.repeat(2001) }],
    });
    expect(r.success).toBe(false);
  });

  it('accepts a rationale at exactly 2000 characters', () => {
    const r = monitoringInlineSettingsSchema.safeParse({
      watches: [{ ...BASE_WATCH, rationale: 'x'.repeat(2000) }],
    });
    expect(r.success).toBe(true);
  });
});
