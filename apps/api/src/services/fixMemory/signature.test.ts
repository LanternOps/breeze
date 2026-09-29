import { describe, expect, it } from 'vitest';
import {
  alertConditionFacets, anomalyConditionFacets, computeSignature, ruleConditionFacets, sourcedAlertFacets,
  type SignatureFacets,
} from './signature';

const base: SignatureFacets = { family: 'alert', condition: 'rule:service_stopped', osFamily: 'windows', discriminator: { kind: 'service', value: 'spooler' }, rootInferred: false };

describe('computeSignature', () => {
  it('is stable across runs and 64 hex chars', () => {
    const a = computeSignature(base)!;
    const b = computeSignature({ ...base })!;
    expect(a.key).toBe(b.key);
    expect(a.key).toMatch(/^[0-9a-f]{64}$/);
    expect(a.version).toBe(1);
  });

  it('differs by OS, family, condition and discriminator', () => {
    const k = computeSignature(base)!.key;
    expect(computeSignature({ ...base, osFamily: 'linux' })!.key).not.toBe(k);
    expect(computeSignature({ ...base, family: 'correlation' })!.key).not.toBe(k);
    expect(computeSignature({ ...base, condition: 'rule:process_stopped' })!.key).not.toBe(k);
    expect(computeSignature({ ...base, discriminator: { kind: 'service', value: 'wuauserv' } })!.key).not.toBe(k);
  });

  it('broadKey ignores the discriminator and equals key when there is none', () => {
    const withD = computeSignature(base)!;
    const without = computeSignature({ ...base, discriminator: null })!;
    expect(withD.broadKey).toBe(without.key);
    expect(without.broad).toBe(true);
    expect(withD.broad).toBe(false);
    expect(without.key).toBe(without.broadKey);
  });

  it('rejects an empty or oversized condition', () => {
    expect(computeSignature({ ...base, condition: '' })).toBeNull();
    expect(computeSignature({ ...base, condition: 'x'.repeat(201) })).toBeNull();
  });
});

describe('ruleConditionFacets', () => {
  it.each([
    [{ type: 'threshold', metric: 'diskPercent', operator: 'gte', value: 90 }, 'rule:metric:diskPercent:high', null],
    [{ type: 'metric', metric: 'ramPercent', operator: 'lt', value: 5 }, 'rule:metric:ramPercent:low', null],
    [{ type: 'offline', durationMinutes: 10 }, 'rule:offline', null],
    [{ type: 'event_log', category: 'system', level: 'error', countThreshold: 1, windowMinutes: 5, messagePattern: 'host-17 failed' }, 'rule:event_log:system:error', null],
    [{ type: 'service_stopped', serviceName: '  Spooler ' }, 'rule:service_stopped', { kind: 'service', value: 'spooler' }],
    [{ type: 'process_memory_high', processName: 'Chrome.exe', operator: 'gt', value: 80 }, 'rule:process_memory_high', { kind: 'process', value: 'chrome.exe' }],
    [{ type: 'software_presence', name: 'Acme Agent', presence: 'not_installed' }, 'rule:software_presence:not_installed', { kind: 'software', value: 'acme agent' }],
    [{ type: 'antivirus', check: 'definitions_stale' }, 'rule:antivirus:definitions_stale', null],
    [{ type: 'script_monitor', monitorId: '11111111-1111-4111-8111-111111111111', intervalMinutes: 5, breachOnNonZeroExit: true }, 'rule:script_monitor', null],
    [{ type: 'hardware_health', componentTypes: ['virtual_disk', 'controller'], minHealth: 'warning', includePredictiveFailure: true, consecutiveSnapshots: 2 }, 'rule:hardware_health:controller+virtual_disk', null],
  ])('%o → %s', (cond, condition, discriminator) => {
    expect(ruleConditionFacets(cond)).toEqual({ condition, discriminator });
  });

  it('never embeds an org-local UUID', () => {
    const f = ruleConditionFacets({ type: 'network_check', monitorId: '22222222-2222-4222-8222-222222222222' })!;
    expect(f.condition).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
  });

  it('orders group members canonically and keeps logic', () => {
    const a = ruleConditionFacets({ logic: 'and', conditions: [{ type: 'offline' }, { type: 'service_stopped', serviceName: 'x' }] });
    const b = ruleConditionFacets({ logic: 'and', conditions: [{ type: 'service_stopped', serviceName: 'x' }, { type: 'offline' }] });
    expect(a).toEqual(b);
    expect(a!.condition).toBe('rule:and(offline,service_stopped)');
    expect(a!.discriminator).toEqual({ kind: 'service', value: 'x' });
  });

  it('drops the discriminator when two leaves each carry one', () => {
    const f = ruleConditionFacets([{ type: 'service_stopped', serviceName: 'a' }, { type: 'service_stopped', serviceName: 'b' }]);
    expect(f!.discriminator).toBeNull();
  });

  it('returns null for unknown or malformed conditions', () => {
    expect(ruleConditionFacets({ type: 'mystery' })).toBeNull();
    expect(ruleConditionFacets(null)).toBeNull();
    expect(ruleConditionFacets({ logic: 'and', conditions: [] })).toBeNull();
  });
});

describe('sourced + alert facets', () => {
  it('script_exit_code carries the exit code discriminator', () => {
    expect(sourcedAlertFacets({ source: 'script_exit_code', scriptId: 's-1', exitCode: 3, executionId: 'e' }))
      .toEqual({ condition: 'sourced:script_exit_code:s-1', discriminator: { kind: 'exit_code', value: '3' } });
  });
  it('network monitor uses the monitor type only (target host is private)', () => {
    expect(sourcedAlertFacets({ source: 'network_monitor', monitorType: 'http', target: 'intranet.example.com' }))
      .toEqual({ condition: 'sourced:network_monitor:http', discriminator: null });
  });
  it('human escalations and unknown sources get no signature', () => {
    expect(sourcedAlertFacets({ source: 'monitor_recurrence' })).toBeNull();
    expect(sourcedAlertFacets({ source: 'something_new' })).toBeNull();
    expect(alertConditionFacets({ requiresHuman: true, context: null, ruleConditions: { type: 'offline' } })).toBeNull();
  });
  it('prefers rule conditions, then falls back to the sourced context', () => {
    expect(alertConditionFacets({ requiresHuman: false, context: { source: 'policy-evaluation' }, ruleConditions: { type: 'offline' } })!.condition).toBe('rule:offline');
    expect(alertConditionFacets({ requiresHuman: false, context: { source: 'policy-evaluation' }, ruleConditions: { type: 'nope' } })!.condition).toBe('sourced:policy_violation');
  });
  it('anomaly facets are the episode key', () => {
    expect(anomalyConditionFacets('device_metrics:spike:cpu')).toEqual({ condition: 'anomaly:device_metrics:spike:cpu', discriminator: null });
  });
});
