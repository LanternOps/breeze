import { expect, it } from 'vitest';
import { aiTools, HELPER_TOOL_SCOPING } from './aiTools';
import { toolInputSchemas } from './aiToolSchemas';
import { TOOL_PERMISSIONS, checkGuardrails } from './aiGuardrails';
import { TOOL_TIERS, buildBreezeSdkTools } from './aiAgentSdkTools';
import { SCRIPT_BUILDER_TOOL_TIERS, buildScriptBuilderTools } from './scriptBuilderTools';
import { getHelperAllowedTools } from './helperToolFilter';
import { TOOL_CAPABILITY } from './aiAgents/agentToolCatalog';

const name = 'query_device_workloads';
const deviceId = '11111111-1111-4111-8111-111111111111';

it('registers tier 1, devices.read, and a schema with enum filters', () => {
  expect(aiTools.get(name)).toMatchObject({ tier: 1, domain: 'devices', deviceArgs: ['deviceId'] });
  expect(aiTools.get(name)!.definition.description).toMatch(/configuration policy/i);
  expect(TOOL_TIERS[name]).toBe(1);
  expect(checkGuardrails(name, { deviceId }).tier).toBe(1);
  expect(TOOL_PERMISSIONS[name]).toEqual({ resource: 'devices', action: 'read' });
  const schema = toolInputSchemas[name]!;
  expect(schema.safeParse({ deviceId }).success).toBe(true);
  expect(schema.safeParse({ deviceId, runtime: 'docker', state: 'running' }).success).toBe(true);
  expect(schema.safeParse({ deviceId, runtime: 'lxc' }).success).toBe(false);
  expect(schema.safeParse({ deviceId, limit: 201 }).success).toBe(false);
  expect(schema.safeParse({}).success).toBe(false);
});

it('is declared on chat, script-builder and helper surfaces', () => {
  const auth = () => {
    throw new Error('declaration inspection must not execute handlers');
  };
  for (const tools of [buildBreezeSdkTools(auth), buildScriptBuilderTools(auth)]) {
    const tool = tools.find((t) => t.name === name);
    expect(tool).toBeDefined();
    expect(Object.keys(tool!.inputSchema).sort()).toEqual(['deviceId', 'limit', 'runtime', 'state']);
  }
  expect(SCRIPT_BUILDER_TOOL_TIERS[name]).toBe(1);
  expect(getHelperAllowedTools('basic')).toContain(name);
  expect(HELPER_TOOL_SCOPING[name]).toBe('deviceId');
  expect(TOOL_CAPABILITY[name]).toBe(TOOL_CAPABILITY.get_device_details);
});
