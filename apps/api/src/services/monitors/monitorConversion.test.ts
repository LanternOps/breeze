import { describe, expect, it } from 'vitest';
import { convertAlertConditionToMonitor } from './monitorConversion';
import { MONITOR_KIND_SPECS } from './kinds';

describe('legacy alert condition → monitor definition (#5289)', () => {
  it('round-trips every kind the registry can compile', () => {
    const samples: Record<string, Record<string, unknown>> = {
      cpu: { operator: 'gt', value: 90, durationMinutes: 10 },
      memory: { operator: 'gte', value: 85 },
      disk: { operator: 'gt', value: 80 },
      offline: { durationMinutes: 15 },
      event_log: { category: 'system', level: 'error', countThreshold: 3, windowMinutes: 60 },
      patch_compliance: { operator: 'lt', value: 80 },
      service: { serviceName: 'Spooler', consecutiveFailures: 2 },
      process: { processName: 'sqlservr.exe' },
      process_resource: { resource: 'memory', processName: 'chrome.exe', operator: 'gt', value: 2048 },
      cert_expiry: { withinDays: 14 },
      bandwidth: { direction: 'total', operator: 'gt', value: 100 },
      disk_io: { direction: 'write', operator: 'gt', value: 50 },
      network_errors: { errorType: 'total', operator: 'gt', value: 100, windowMinutes: 15 },
    };

    for (const [kind, sample] of Object.entries(samples)) {
      const spec = MONITOR_KIND_SPECS[kind as keyof typeof MONITOR_KIND_SPECS];
      const compiled = spec.toAlertCondition(spec.conditionSchema.parse(sample), { monitorId: 'm0000000-0000-4000-8000-000000000001' });
      const converted = convertAlertConditionToMonitor(compiled);
      expect(converted, `${kind} did not convert back`).not.toBeNull();
      expect(converted!.kind).toBe(kind);
      expect(converted!.condition).toEqual(spec.conditionSchema.parse(sample));
    }
  });

  it('accepts a single-element array (templates store both shapes)', () => {
    const converted = convertAlertConditionToMonitor([
      { type: 'threshold', metric: 'cpuPercent', operator: 'gt', value: 90 },
    ]);
    expect(converted?.kind).toBe('cpu');
  });

  it('refuses a condition GROUP — a monitor has exactly one root condition', () => {
    expect(
      convertAlertConditionToMonitor({
        logic: 'and',
        conditions: [
          { type: 'threshold', metric: 'cpuPercent', operator: 'gt', value: 90 },
          { type: 'offline', durationMinutes: 5 },
        ],
      }),
    ).toBeNull();
  });

  it('refuses a multi-condition array', () => {
    expect(
      convertAlertConditionToMonitor([
        { type: 'threshold', metric: 'cpuPercent', operator: 'gt', value: 90 },
        { type: 'offline', durationMinutes: 5 },
      ]),
    ).toBeNull();
  });

  it('refuses a metric with no monitor kind (processCount) rather than mapping it to something else', () => {
    expect(
      convertAlertConditionToMonitor({ type: 'threshold', metric: 'processCount', operator: 'gt', value: 500 }),
    ).toBeNull();
  });

  it('refuses an unknown condition type and a malformed condition', () => {
    expect(convertAlertConditionToMonitor({ type: 'wmi_query', query: 'x' })).toBeNull();
    expect(convertAlertConditionToMonitor({ type: 'cert_expiry', withinDays: 9999 })).toBeNull();
    expect(convertAlertConditionToMonitor(null)).toBeNull();
    expect(convertAlertConditionToMonitor('threshold')).toBeNull();
  });
});
