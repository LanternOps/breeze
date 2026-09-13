import { describe, it, expect } from 'vitest';
import {
  createMonitorDefinitionSchema,
  updateMonitorDefinitionSchema,
  monitorConditionSchemas,
  monitorsInlineSettingsSchema,
  MONITOR_KINDS,
} from './monitors';
import { automationTriggerSchema } from './index';

describe('monitor definition validators (#5289)', () => {
  it('lists the W02 kinds', () => {
    expect(MONITOR_KINDS).toEqual([
      'cpu',
      'memory',
      'disk',
      'offline',
      'event_log',
      'patch_compliance',
      'service',
      'process',
      'process_resource',
      'cert_expiry',
      'bandwidth',
      'disk_io',
      'network_errors',
    ]);
  });

  it('accepts a cpu monitor with a threshold condition and rejects an unknown condition key', () => {
    const ok = createMonitorDefinitionSchema.safeParse({
      ownerScope: 'organization',
      name: 'High CPU',
      kind: 'cpu',
      severity: 'high',
      condition: { operator: 'gt', value: 90, durationMinutes: 10 },
      responses: [],
    });
    expect(ok.success).toBe(true);
    const bad = monitorConditionSchemas.cpu.safeParse({ operator: 'gt', value: 90, metric: 'ramPercent' });
    expect(bad.success).toBe(false);
  });

  it('rejects a condition that does not match the kind', () => {
    const r = createMonitorDefinitionSchema.safeParse({
      ownerScope: 'organization',
      name: 'Mismatched',
      kind: 'cert_expiry',
      severity: 'low',
      condition: { operator: 'gt', value: 90 },
      responses: [],
    });
    expect(r.success).toBe(false);
  });

  it('requires recurrence threshold and window together', () => {
    const r = createMonitorDefinitionSchema.safeParse({
      ownerScope: 'organization',
      name: 'x',
      kind: 'offline',
      severity: 'high',
      condition: { durationMinutes: 15 },
      responses: [],
      recurrenceThreshold: 3,
    });
    expect(r.success).toBe(false);
  });

  it('requires deliveryChannelIds when deliveryMode is channels', () => {
    const r = createMonitorDefinitionSchema.safeParse({
      ownerScope: 'organization',
      name: 'x',
      kind: 'offline',
      severity: 'high',
      condition: { durationMinutes: 15 },
      deliveryMode: 'channels',
    });
    expect(r.success).toBe(false);
  });

  it('requires aiAgentId for an ai_triage response', () => {
    const r = createMonitorDefinitionSchema.safeParse({
      ownerScope: 'organization',
      name: 'x',
      kind: 'offline',
      severity: 'high',
      condition: { durationMinutes: 15 },
      responses: [{ type: 'ai_triage' }],
    });
    expect(r.success).toBe(false);
  });

  it('update strips ownerScope', () => {
    const r = updateMonitorDefinitionSchema.safeParse({ ownerScope: 'partner', name: 'renamed' });
    expect(r.success).toBe(true);
    expect(r.success && 'ownerScope' in r.data).toBe(false);
  });

  it('inline settings carry attachment items', () => {
    const r = monitorsInlineSettingsSchema.safeParse({
      items: [
        { monitorId: '6b1f2b3a-0000-4000-8000-000000000001', enabled: false, overrides: { value: 95 } },
      ],
    });
    expect(r.success).toBe(true);
    expect(r.success && r.data.items[0].enabled).toBe(false);
  });

  it('event trigger accepts filter', () => {
    const r = automationTriggerSchema.safeParse({
      type: 'event',
      event: 'alert.triggered',
      filter: { ruleId: 'abc' },
    });
    expect(r.success).toBe(true);
    expect(r.success && (r.data as { filter?: unknown }).filter).toEqual({ ruleId: 'abc' });
  });
});
