import { describe, it, expect } from 'vitest';
import { MONITOR_KINDS } from '@breeze/shared';
import { validateConditions } from '../../alertConditions';
import { MONITOR_KIND_SPECS, applyOverrides, getMonitorKindSpec } from './index';

const SAMPLES: Record<string, Record<string, unknown>> = {
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
  // W04 (#5291) coverage kinds.
  antivirus: { check: 'definitions_stale', staleAfterDays: 7 },
  software_presence: { name: 'TeamViewer', presence: 'installed' },
  backup_continuity: { check: 'no_successful_backup', maxAgeHours: 26 },
  script: { scriptId: '11111111-2222-4333-8444-555555555555', intervalMinutes: 60, timeoutSeconds: 300 },
  network_check: { checkType: 'icmp_ping', target: '10.0.0.1' },
  // W05c1: composite compiles to a group, so the per-kind loop below validates
  // the whole tree through validateConditions like every leaf.
  composite: {
    match: 'any',
    children: [
      { kind: 'cpu', condition: { operator: 'gt', value: 90 } },
      { kind: 'offline', condition: { durationMinutes: 10 } },
    ],
  },
  // W03 (hardware & RAID monitoring).
  hardware_health: { componentTypes: ['physical_disk'], minHealth: 'critical', includePredictiveFailure: true, consecutiveSnapshots: 2 },
};

describe('monitor kind registry (#5289)', () => {
  it('ships twenty kinds with hardware health', () => {
    expect(MONITOR_KINDS).toHaveLength(20);
  });

  it('has a spec for every kind and every compiled condition validates against alertConditions', () => {
    for (const kind of MONITOR_KINDS) {
      const spec = MONITOR_KIND_SPECS[kind];
      expect(spec, kind).toBeDefined();
      const condition = spec.conditionSchema.parse(SAMPLES[kind]);
      const compiled = spec.toAlertCondition(condition, { monitorId: 'm0000000-0000-4000-8000-000000000001' });
      expect(validateConditions(compiled), `${kind}: ${JSON.stringify(compiled)}`).toEqual([]);
    }
  });

  it('cpu compiles to a threshold on cpuPercent', () => {
    expect(MONITOR_KIND_SPECS.cpu.toAlertCondition({ operator: 'gt', value: 90, durationMinutes: 10 }, { monitorId: 'm1' }))
      .toEqual({ type: 'threshold', metric: 'cpuPercent', operator: 'gt', value: 90, durationMinutes: 10 });
  });

  it('process_resource picks the handler type from resource', () => {
    const compiled = MONITOR_KIND_SPECS.process_resource.toAlertCondition(
      { resource: 'memory', processName: 'x', operator: 'gt', value: 1 }, { monitorId: 'm1' });
    expect('type' in compiled).toBe(true);
    if (!('type' in compiled)) throw new Error('Expected a leaf condition');
    expect(compiled.type).toBe('process_memory_high');
  });

  it('applyOverrides only touches overridable keys and re-validates', () => {
    const out = applyOverrides(MONITOR_KIND_SPECS.disk, { operator: 'gt', value: 80 }, { value: 95, operator: 'lt', metric: 'ramPercent' });
    expect(out).toEqual({ operator: 'lt', value: 95 });
    expect(() => applyOverrides(MONITOR_KIND_SPECS.disk, { operator: 'gt', value: 80 }, { value: 500 })).toThrow();
  });

  it('unknown kind throws', () => {
    expect(() => getMonitorKindSpec('wmi_query')).toThrow(/unknown monitor kind/);
  });
});
