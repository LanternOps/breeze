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

describe('BUILT_IN_MONITORS_VERSION', () => {
  it('is 2', () => {
    expect(BUILT_IN_MONITORS_VERSION).toBe(2);
  });
});

describe('BUILT_IN_MONITOR_DEFAULTS', () => {
  it('ships a fourth built-in for patch compliance', () => {
    const patch = BUILT_IN_MONITOR_DEFAULTS.find((d) => d.key === 'patch_compliance_low');
    expect(patch).toBeDefined();
    expect(patch?.kind).toBe('patch_compliance');
    expect(patch?.severity).toBe('medium');
    expect(patch?.condition).toEqual({ operator: 'lt', value: 80 });
    expect(patch?.sinceVersion).toBe(2);
  });

  it('has exactly four defaults', () => {
    expect(BUILT_IN_MONITOR_DEFAULTS).toHaveLength(4);
  });

  it('the three pre-existing defaults are sinceVersion 1', () => {
    for (const key of ['cpu_high', 'memory_high', 'disk_full'] as const) {
      const def = BUILT_IN_MONITOR_DEFAULTS.find((d) => d.key === key);
      expect(def?.sinceVersion).toBe(1);
    }
  });

  it('every default condition passes its kind conditionSchema', () => {
    for (const def of BUILT_IN_MONITOR_DEFAULTS) {
      const parsed = getMonitorKindSpec(def.kind).conditionSchema.safeParse(def.condition);
      expect(parsed.success, `${def.key} condition failed schema: ${JSON.stringify(parsed)}`).toBe(true);
    }
  });
});

describe('defaultsToProvision', () => {
  it('returns all four defaults for a never-provisioned partner (null)', () => {
    const result = defaultsToProvision(null);
    expect(result.map((d) => d.key).sort()).toEqual(
      ['cpu_high', 'disk_full', 'memory_high', 'patch_compliance_low'].sort(),
    );
  });

  it('returns only the new default for a partner already at version 1', () => {
    const result = defaultsToProvision(1);
    expect(result.map((d) => d.key)).toEqual(['patch_compliance_low']);
  });

  it('returns nothing for a partner already at the current version', () => {
    expect(defaultsToProvision(2)).toEqual([]);
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
