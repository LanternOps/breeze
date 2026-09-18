import { describe, it, expect } from 'vitest';
import { PATCH_ALERT_CATEGORY } from '@breeze/shared';
import {
  buildCompiledTemplate,
  buildCompiledRule,
  buildCompiledAutomation,
  computeCompiledHash,
} from './monitorCompiler';
import type { MonitorDefinitionRow } from '../../db/schema/monitorDefinitions';

const def = {
  id: 'd0000000-0000-4000-8000-000000000001',
  orgId: 'o0000000-0000-4000-8000-000000000001',
  partnerId: null,
  name: 'Disk over 80%',
  description: null,
  kind: 'disk',
  enabled: true,
  condition: { operator: 'gt', value: 80, durationMinutes: 15 },
  severity: 'high',
  cooldownMinutes: 30,
  autoResolve: true,
  autoResolveConditions: null,
  responses: [
    { type: 'run_script', scriptId: 's0000000-0000-4000-8000-000000000001', runAs: 'system' },
  ],
  deliveryMode: 'channels',
  deliveryChannelIds: ['c0000000-0000-4000-8000-000000000001'],
  escalationPolicyId: null,
  recurrenceThreshold: 3,
  recurrenceWindowHours: 240,
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
} as unknown as MonitorDefinitionRow;

describe('monitor compiler builders (#5289)', () => {
  it('template is built-in, managed, and carries a SINGLE root condition (never an array)', () => {
    const t = buildCompiledTemplate(def);
    expect(t.isBuiltIn).toBe(true);
    expect(t.managedByMonitorId).toBe(def.id);
    expect(t.orgId).toBe(def.orgId);
    expect(t.partnerId).toBeNull();
    expect(t.conditions).toEqual({
      type: 'threshold',
      metric: 'diskPercent',
      operator: 'gt',
      value: 80,
      durationMinutes: 15,
    });
    expect(Array.isArray(t.conditions)).toBe(false);
    expect(t.cooldownMinutes).toBe(30);
    expect(t.autoResolve).toBe(true);
  });

  it('a cpu-kind template carries the general monitor category', () => {
    const t = buildCompiledTemplate(def);
    expect(t.category).toBe('monitor');
  });

  it('a patch_compliance-kind template carries the patching category', () => {
    const t = buildCompiledTemplate({
      ...def,
      kind: 'patch_compliance',
      condition: { operator: 'lt', value: 80 },
    });
    expect(t.category).toBe(PATCH_ALERT_CATEGORY);
  });

  it('rule targets the monitor and carries delivery overrides', () => {
    const r = buildCompiledRule(def, 't0000000-0000-4000-8000-000000000001');
    expect(r.targetType).toBe('monitor');
    expect(r.targetId).toBe(def.id);
    expect(r.isActive).toBe(true);
    expect(r.managedByMonitorId).toBe(def.id);
    expect(r.overrideSettings).toEqual({
      notificationChannelIds: def.deliveryChannelIds,
      escalationPolicyId: null,
      deliveryMode: 'channels',
    });
  });

  it('a disabled monitor compiles to an inactive rule', () => {
    const r = buildCompiledRule({ ...def, enabled: false }, 't1');
    expect(r.isActive).toBe(false);
  });

  it("deliveryMode 'none' compiles to no channels, so the dispatcher's org fallback cannot re-add them", () => {
    const r = buildCompiledRule({ ...def, deliveryMode: 'none' }, 't1');
    expect((r.overrideSettings as { notificationChannelIds: string[] }).notificationChannelIds).toEqual([]);
    expect((r.overrideSettings as { deliveryMode: string }).deliveryMode).toBe('none');
  });

  it('automation is event-triggered on the compiled rule only, managed, and not agent-bound', () => {
    const a = buildCompiledAutomation(def, 'r0000000-0000-4000-8000-000000000001');
    expect(a.trigger).toEqual({
      type: 'event',
      event: 'alert.triggered',
      filter: { ruleId: 'r0000000-0000-4000-8000-000000000001' },
    });
    expect(a.actions).toEqual(def.responses);
    expect(a.managedByMonitorId).toBe(def.id);
    expect(a.managedByAgentId).toBeNull();
    expect(a.enabled).toBe(true);
  });

  it('an automation with no responses compiles disabled', () => {
    const a = buildCompiledAutomation({ ...def, responses: [] }, 'r1');
    expect(a.enabled).toBe(false);
  });

  it('an ai_triage response binds the automation to the definition ai agent', () => {
    const a = buildCompiledAutomation(
      { ...def, responses: [{ type: 'ai_triage' }], aiAgentId: 'a1' },
      'r1',
    );
    expect(a.managedByAgentId).toBe('a1');
  });

  it('hash is stable across compiled_* changes and changes with the condition', () => {
    const h1 = computeCompiledHash(def);
    const h2 = computeCompiledHash({
      ...def,
      compiledHash: 'x',
      compiledAt: new Date(0),
      updatedAt: new Date(0),
    });
    const h3 = computeCompiledHash({ ...def, condition: { ...def.condition, value: 81 } });
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
  });

  it('hash ignores key order inside the condition', () => {
    const h1 = computeCompiledHash(def);
    const h2 = computeCompiledHash({
      ...def,
      condition: { durationMinutes: 15, value: 80, operator: 'gt' },
    });
    expect(h1).toBe(h2);
  });
});
