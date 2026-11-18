import { describe, expect, it } from 'vitest';
import { aiTools } from './aiToolNames';
import { toolInputSchemas, validateToolInput } from './aiToolSchemas';
import { aiReadToolShapes } from './aiToolSchemasAiReads';
import { toolActionEnum } from './aiToolActions';

// W10 (#6780): the registry input_schema, the toolInputSchemas entry and the SDK shape must agree
// (inputShape() takes the Zod .shape directly, so Zod IS the SDK surface).
const W10_TOOLS = Object.keys(aiReadToolShapes);
const UUID = '11111111-1111-4111-8111-111111111111';
const shapeOf = (name: string) => (toolInputSchemas[name] as unknown as { shape: Record<string, { isOptional: () => boolean }> }).shape;

describe('W10 AI-agent read tool input schemas', () => {
  it('covers exactly the six W10 tools (reads only: no run, apply, create, update or cancel)', () => {
    expect([...W10_TOOLS].sort()).toEqual([
      'get_device_ai_activity', 'get_fleet_design', 'get_operator_task',
      'list_ai_agent_schedules', 'list_fleet_designs', 'list_operator_tasks',
    ]);
    for (const name of W10_TOOLS) expect(aiTools.has(name), name).toBe(true);
  });

  it.each(W10_TOOLS)('%s: registry properties and Zod keys agree, strict', (name) => {
    const schema = aiTools.get(name)!.definition.input_schema as { properties: Record<string, unknown>; additionalProperties?: boolean };
    expect(Object.keys(schema.properties).sort()).toEqual(Object.keys(shapeOf(name)).sort());
    expect(schema.additionalProperties).toBe(false);
  });

  it.each(W10_TOOLS)('%s: every registry-required key is required by Zod too, and nothing else is', (name) => {
    const required = (aiTools.get(name)!.definition.input_schema as { required?: string[] }).required ?? [];
    for (const key of required) {
      expect(shapeOf(name)[key]!.isOptional(), `${name}.${key} is required in the registry but optional in Zod`).toBe(false);
    }
    const zodRequired = Object.entries(shapeOf(name)).filter(([, v]) => !v.isOptional()).map(([k]) => k).sort();
    expect(zodRequired).toEqual([...required].sort());
  });

  it.each(W10_TOOLS)('%s: no action enum (each tool is one read)', (name) => {
    expect(toolActionEnum(name) ?? []).toEqual([]);
  });

  it('domains and tiers: all six are tier 1 in the ai domain', () => {
    for (const name of W10_TOOLS) {
      expect(aiTools.get(name)!.domain, name).toBe('ai');
      expect(aiTools.get(name)!.tier, name).toBe(1);
    }
  });

  it('only the two device-naming tools declare deviceArgs, so the executor pre-checks the id', () => {
    expect(aiTools.get('get_device_ai_activity')!.deviceArgs).toEqual(['device_id']);
    expect(aiTools.get('list_operator_tasks')!.deviceArgs).toEqual(['device_id']);
    for (const name of W10_TOOLS.filter((n) => n !== 'get_device_ai_activity' && n !== 'list_operator_tasks')) {
      expect(aiTools.get(name)!.deviceArgs ?? [], name).toEqual([]);
    }
  });

  it('no write verbs anywhere in the input surface (those are W16)', () => {
    for (const name of W10_TOOLS) {
      for (const key of Object.keys(shapeOf(name))) {
        expect(key, `${name}.${key}`).not.toMatch(/^(run|apply|create|update|cancel|delete|enable|approve)/i);
      }
    }
  });

  it.each(W10_TOOLS)('%s rejects an unknown key (strict)', (name) => {
    const base = name === 'get_device_ai_activity' ? { device_id: UUID }
      : name === 'get_operator_task' ? { taskId: UUID }
        : name === 'get_fleet_design' ? { reportRunId: UUID }
          : {};
    expect(validateToolInput(name, base).success).toBe(true);
    expect(validateToolInput(name, { ...base, surprise: true }).success).toBe(false);
  });

  it('accepts representative valid inputs', () => {
    expect(validateToolInput('get_device_ai_activity', { device_id: UUID, days: 30, source: 'command', sourceId: UUID }).success).toBe(true);
    expect(validateToolInput('list_operator_tasks', { device_id: UUID, state: 'queued', limit: 50, cursor: 'abc' }).success).toBe(true);
    expect(validateToolInput('list_ai_agent_schedules', { agentId: UUID, orgId: UUID, limit: 200 }).success).toBe(true);
    expect(validateToolInput('list_fleet_designs', { orgId: UUID, limit: 100 }).success).toBe(true);
  });

  it('rejects malformed ids, out-of-range numbers and unknown enum values', () => {
    expect(validateToolInput('get_device_ai_activity', { device_id: 'nope' }).success).toBe(false);
    expect(validateToolInput('get_device_ai_activity', {}).success).toBe(false);
    expect(validateToolInput('get_device_ai_activity', { device_id: UUID, days: 31 }).success).toBe(false);
    expect(validateToolInput('get_device_ai_activity', { device_id: UUID, source: 'script' }).success).toBe(false);
    expect(validateToolInput('list_operator_tasks', { limit: 51 }).success).toBe(false);
    expect(validateToolInput('list_operator_tasks', { state: 'exploded' }).success).toBe(false);
    expect(validateToolInput('list_fleet_designs', { limit: 101 }).success).toBe(false);
    expect(validateToolInput('list_ai_agent_schedules', { limit: 201 }).success).toBe(false);
    expect(validateToolInput('get_operator_task', { taskId: 'nope' }).success).toBe(false);
    expect(validateToolInput('get_fleet_design', {}).success).toBe(false);
  });
});
