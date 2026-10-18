import { expect, it } from 'vitest';
import { aiTools, HELPER_TOOL_SCOPING } from './aiTools';
import { toolInputSchemas } from './aiToolSchemas';
import { TOOL_PERMISSIONS, checkGuardrails } from './aiGuardrails';
import { TOOL_TIERS, buildBreezeSdkTools } from './aiAgentSdkTools';
import { getHelperAllowedTools } from './helperToolFilter';
import { TOOL_CAPABILITY } from './aiAgents/agentToolCatalog';
import { PATCH_TOOL_ALLOWLIST } from './aiAgents/patchProfile';
import { MCP_COVERAGE } from './mcpCoverage';

const name = 'list_device_restore_point_attempts';
const deviceId = '11111111-1111-4111-8111-111111111111';

it('registers schema, read permission and tier', () => {
  expect(aiTools.get(name)).toMatchObject({ tier: 1, domain: 'devices', deviceArgs: ['deviceId'] });
  expect(TOOL_TIERS[name]).toBe(1);
  expect(checkGuardrails(name, { deviceId }).tier).toBe(1);
  expect(TOOL_PERMISSIONS[name]).toEqual({ resource: 'devices', action: 'read' });
  const schema = toolInputSchemas[name]!;
  expect(schema.safeParse({ deviceId }).success).toBe(true);
  expect(schema.safeParse({ deviceId, trigger: 'patch', status: 'requested', limit: 50, offset: 0 }).success).toBe(true);
  for (const input of [
    {},
    { deviceId: 'invalid' },
    { deviceId, trigger: 'reboot' },
    { deviceId, status: 'recoverable' },
    { deviceId, limit: 51 },
  ]) {
    expect(schema.safeParse(input).success).toBe(false);
  }
});

it('declares a callable chat tool whose input keys match the registry schema', () => {
  const auth = () => {
    throw new Error('declaration inspection must not execute handlers');
  };
  const sdkTool = buildBreezeSdkTools(auth).find((t) => t.name === name);
  expect(sdkTool).toBeDefined();
  expect(typeof sdkTool!.handler).toBe('function');
  const registryKeys = Object.keys(aiTools.get(name)!.definition.input_schema.properties ?? {}).sort();
  expect(Object.keys(sdkTool!.inputSchema).sort()).toEqual(registryKeys);
});

it('replaces the internal_plumbing MCP exemption and joins the device-read catalog', () => {
  expect(MCP_COVERAGE['devices/restorePoints.ts']).toEqual({ tools: [name] });
  expect(TOOL_CAPABILITY[name]).toBe(TOOL_CAPABILITY.get_device_details);
  // The patch agent plans installs that may take a checkpoint first.
  expect(PATCH_TOOL_ALLOWLIST).toContain(name);
  // Not offered to the end-user Helper: technician history, not self-service.
  expect(getHelperAllowedTools('basic')).not.toContain(name);
  expect(HELPER_TOOL_SCOPING[name]).toBeUndefined();
});
