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
  it('lists the W02 kinds, then the W04 coverage kinds', () => {
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
      'antivirus',
      'software_presence',
      'backup_continuity',
      'script',
      'network_check',
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
    expect(r.success && r.data.items[0]!.enabled).toBe(false);
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

/**
 * W04 coverage kinds (#5287 / #5291).
 *
 * Each case below rejects ONE specific malformation rather than `{}` — a
 * `.strict()` object rejects `{}` for every kind, which discriminates nothing.
 */
describe('W04 coverage condition schemas (#5291)', () => {
  it('lists the five W04 kinds after the W02 thirteen', () => {
    expect(MONITOR_KINDS.slice(13)).toEqual([
      'antivirus',
      'software_presence',
      'backup_continuity',
      'script',
      'network_check',
    ]);
  });

  it('antivirus: definitions_stale requires staleAfterDays', () => {
    expect(monitorConditionSchemas.antivirus.safeParse({ check: 'definitions_stale', staleAfterDays: 7 }).success).toBe(true);
    expect(monitorConditionSchemas.antivirus.safeParse({ check: 'realtime_disabled' }).success).toBe(true);
    // The malformation: the stale check with no staleness window is unanswerable.
    expect(monitorConditionSchemas.antivirus.safeParse({ check: 'definitions_stale' }).success).toBe(false);
  });

  it('software_presence: version_below requires a version', () => {
    expect(monitorConditionSchemas.software_presence.safeParse({ name: 'TeamViewer', presence: 'installed' }).success).toBe(true);
    expect(monitorConditionSchemas.software_presence.safeParse({ name: 'Java', presence: 'version_below', version: '10.2' }).success).toBe(true);
    expect(monitorConditionSchemas.software_presence.safeParse({ name: 'Java', presence: 'version_below' }).success).toBe(false);
  });

  it('backup_continuity: each check requires its own parameter', () => {
    expect(monitorConditionSchemas.backup_continuity.safeParse({ check: 'no_successful_backup', maxAgeHours: 26 }).success).toBe(true);
    expect(monitorConditionSchemas.backup_continuity.safeParse({ check: 'consecutive_failures', failureCount: 3 }).success).toBe(true);
    expect(monitorConditionSchemas.backup_continuity.safeParse({ check: 'no_successful_backup', failureCount: 3 }).success).toBe(false);
    expect(monitorConditionSchemas.backup_continuity.safeParse({ check: 'consecutive_failures', maxAgeHours: 26 }).success).toBe(false);
  });

  it('script: scriptId must be a uuid and the interval floor holds', () => {
    const parsed = monitorConditionSchemas.script.parse({ scriptId: '11111111-2222-4333-8444-555555555555' });
    expect(parsed).toEqual({
      scriptId: '11111111-2222-4333-8444-555555555555',
      intervalMinutes: 60,
      timeoutSeconds: 300,
      breachOnNonZeroExit: true,
    });
    expect(monitorConditionSchemas.script.safeParse({ scriptId: 'not-a-uuid' }).success).toBe(false);
    // A 1-minute probe interval would hammer every attached device.
    expect(monitorConditionSchemas.script.safeParse({ scriptId: '11111111-2222-4333-8444-555555555555', intervalMinutes: 1 }).success).toBe(false);
  });

  it('network_check: tcp_port requires a port', () => {
    expect(monitorConditionSchemas.network_check.safeParse({ checkType: 'icmp_ping', target: '10.0.0.1' }).success).toBe(true);
    expect(monitorConditionSchemas.network_check.safeParse({ checkType: 'tcp_port', target: '10.0.0.1', port: 443 }).success).toBe(true);
    expect(monitorConditionSchemas.network_check.safeParse({ checkType: 'tcp_port', target: '10.0.0.1' }).success).toBe(false);
  });

  it('a definition whose condition does not match its kind is rejected', () => {
    const result = createMonitorDefinitionSchema.safeParse({
      name: 'AV stale',
      kind: 'antivirus',
      severity: 'high',
      // A software_presence condition under the antivirus kind.
      condition: { name: 'TeamViewer', presence: 'installed' },
    });
    expect(result.success).toBe(false);
  });
});
