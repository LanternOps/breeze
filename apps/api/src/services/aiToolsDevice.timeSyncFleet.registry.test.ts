import { expect, it } from 'vitest';
import {
  aiTools,
  HELPER_TOOL_SCOPING,
  applyHelperDeviceScope,
} from './aiTools';
import { toolInputSchemas } from './aiToolSchemas';
import { TOOL_PERMISSIONS, checkGuardrails } from './aiGuardrails';
import { TOOL_TIERS, buildBreezeSdkTools } from './aiAgentSdkTools';
import {
  SCRIPT_BUILDER_TOOL_TIERS,
  buildScriptBuilderTools,
} from './scriptBuilderTools';
import { getHelperAllowedTools } from './helperToolFilter';
import { TOOL_CAPABILITY } from './aiAgents/agentToolCatalog';
import { ANALYSIS_TOOL_ALLOWLIST } from './aiAgents/analysisProfile';
import { SWEEP_TOOL_ALLOWLIST } from './aiAgents/sweepProfile';
import { VERDICT_TOOL_ALLOWLIST } from './aiAgents/verdictProfile';
import { DESIGN_TOOL_ALLOWLIST } from './aiAgents/designProfile';
import { PATCH_TOOL_ALLOWLIST } from './aiAgents/patchProfile';
import { MCP_PROMPTS } from './mcpGuidance';
const name = 'list_time_sync_issues',
  deviceId = '11111111-1111-4111-8111-111111111111';
it('registers validated tier-one reads on every execution surface', () => {
  expect(aiTools.get(name)).toMatchObject({
    tier: 1,
    domain: 'devices',
    deviceArgs: ['deviceId'],
  });
  expect(TOOL_TIERS[name]).toBe(1);
  expect(checkGuardrails(name, {}).tier).toBe(1);
  expect(TOOL_PERMISSIONS[name]).toEqual({
    resource: 'devices',
    action: 'read',
  });
  const schema = toolInputSchemas[name]!;
  expect(schema.safeParse({}).success).toBe(true);
  expect(
    schema.safeParse({
      deviceId,
      finding: 'sync_stale',
      role: 'member',
      domain: 'example.com',
      page: 2,
      limit: 100,
    }).success,
  ).toBe(true);
  for (const input of [
    { deviceId: 'invalid' },
    { finding: 'invented' },
    { role: 'admin' },
    { page: 0 },
    { limit: 101 },
  ])
    expect(schema.safeParse(input).success).toBe(false);
  const auth = () => {
    throw new Error('Declaration inspection cannot execute handlers');
  };
  for (const tools of [
    buildBreezeSdkTools(auth),
    buildScriptBuilderTools(auth),
  ]) {
    const tool = tools.find((t) => t.name === name);
    expect(tool).toBeDefined();
    expect(typeof tool!.handler).toBe('function');
    expect(Object.keys(tool!.inputSchema).sort()).toEqual([
      'deviceId',
      'domain',
      'finding',
      'health',
      'limit',
      'orgId',
      'page',
      'role',
      'siteId',
    ]);
  }
  expect(SCRIPT_BUILDER_TOOL_TIERS[name]).toBe(1);
});
it('pins Helper enumeration and domain context to its own device', () => {
  expect(getHelperAllowedTools('basic')).toContain(name);
  expect(HELPER_TOOL_SCOPING[name]).toBe('deviceId');
  expect(
    applyHelperDeviceScope(
      name,
      { deviceId: 'other', role: 'member' },
      deviceId,
    ),
  ).toEqual({ input: { deviceId, role: 'member' } });
  for (const list of [
    ANALYSIS_TOOL_ALLOWLIST,
    SWEEP_TOOL_ALLOWLIST,
    VERDICT_TOOL_ALLOWLIST,
    DESIGN_TOOL_ALLOWLIST,
    PATCH_TOOL_ALLOWLIST,
  ])
    expect(list).toContain(name);
  expect(TOOL_CAPABILITY[name]).toBe('automations_reports');
  expect(
    MCP_PROMPTS.find((p) => p.name === 'breeze-device-investigate')!
      .referencedTools,
  ).toContain(name);
});
