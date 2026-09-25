import { describe, it, expect } from 'vitest';
import { PATCH_ALERT_CATEGORY } from '@breeze/shared';
import {
  BUILT_IN_MONITOR_DEFAULTS,
  BUILT_IN_MONITORS_VERSION,
  defaultsToProvision,
} from './builtInMonitors';
import { getMonitorKindSpec } from './kinds';
import { buildCompiledTemplate } from './monitorCompiler';
import type { MonitorDefinitionRow } from '../../db/schema/monitorDefinitions';

describe('version 3 hardware defaults', () => {
  const keys = ['raid_array_degraded', 'physical_disk_failed', 'cache_battery_problem', 'hardware_collector_failing'];

  it('has eight valid defaults, four introduced at version 3', () => {
    expect(BUILT_IN_MONITORS_VERSION).toBe(3);
    expect(BUILT_IN_MONITOR_DEFAULTS).toHaveLength(8);
    expect(defaultsToProvision(2).map((d) => d.key)).toEqual(keys);
    for (const d of BUILT_IN_MONITOR_DEFAULTS) {
      expect(getMonitorKindSpec(d.kind).conditionSchema.safeParse(d.condition).success).toBe(true);
    }
  });

  it('preserves historical version gates', () => {
    expect(defaultsToProvision(null)).toHaveLength(8);
    expect(defaultsToProvision(1).map((d) => d.key)).toEqual(['patch_compliance_low', ...keys]);
    expect(defaultsToProvision(3)).toEqual([]);
    expect(BUILT_IN_MONITOR_DEFAULTS.filter((d) => d.sinceVersion === 1).map((d) => d.key)).toEqual([
      'cpu_high',
      'memory_high',
      'disk_full',
    ]);
    expect(BUILT_IN_MONITOR_DEFAULTS.find((d) => d.key === 'patch_compliance_low')?.condition).toEqual({
      operator: 'lt',
      value: 80,
    });
  });

  it('matches the four approved settings exactly', () => {
    expect(
      defaultsToProvision(2).map((d) => [d.key, d.name, d.condition, d.severity, d.cooldownMinutes, d.sinceVersion]),
    ).toEqual([
      [
        'raid_array_degraded',
        'RAID array degraded or failed',
        { componentTypes: ['virtual_disk', 'controller'], minHealth: 'critical', includePredictiveFailure: false, consecutiveSnapshots: 2 },
        'critical',
        60,
        3,
      ],
      [
        'physical_disk_failed',
        'Physical disk failed or predicted to fail',
        { componentTypes: ['physical_disk'], minHealth: 'critical', includePredictiveFailure: true, consecutiveSnapshots: 2 },
        'high',
        60,
        3,
      ],
      [
        'cache_battery_problem',
        'Controller cache battery problem',
        { componentTypes: ['cache_battery'], minHealth: 'warning', includePredictiveFailure: false, consecutiveSnapshots: 3 },
        'medium',
        240,
        3,
      ],
      [
        'hardware_collector_failing',
        'Hardware monitoring tool failing',
        { componentTypes: ['collector'], minHealth: 'warning', includePredictiveFailure: false, consecutiveSnapshots: 3 },
        'low',
        1440,
        3,
      ],
    ]);
  });
});

describe('buildCompiledTemplate category via alertCategory', () => {
  function makeDef(overrides: Partial<MonitorDefinitionRow>): MonitorDefinitionRow {
    return {
      id: 'd0000000-0000-4000-8000-000000000001',
      orgId: 'o0000000-0000-4000-8000-000000000001',
      partnerId: null,
      name: 'Test monitor',
      description: null,
      kind: 'cpu',
      enabled: true,
      condition: { operator: 'gt', value: 90, durationMinutes: 15 },
      severity: 'high',
      cooldownMinutes: 60,
      autoResolve: true,
      autoResolveConditions: null,
      responses: [],
      deliveryMode: 'inherit',
      deliveryChannelIds: [],
      escalationPolicyId: null,
      recurrenceThreshold: null,
      recurrenceWindowHours: null,
      recurrenceActions: [],
      pauseResponsesOnEscalation: true,
      aiAgentId: null,
      compiledAlertTemplateId: null,
      compiledAlertRuleId: null,
      compiledAutomationId: null,
      compiledHash: null,
      compiledAt: null,
      createdBy: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      builtinKey: null,
      ...overrides,
    } as unknown as MonitorDefinitionRow;
  }

  it('a patch_compliance definition compiles to a template carrying the patching category', () => {
    const def = makeDef({ kind: 'patch_compliance', condition: { operator: 'lt', value: 80 } });
    const tpl = buildCompiledTemplate(def);
    expect(tpl.category).toBe(PATCH_ALERT_CATEGORY);
  });

  it('a cpu definition still compiles to the general monitor category', () => {
    const def = makeDef({ kind: 'cpu' });
    const tpl = buildCompiledTemplate(def);
    expect(tpl.category).toBe('monitor');
  });
});
