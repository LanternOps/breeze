import { describe, it, expect } from 'vitest';
import { aiTools } from './aiTools';
import { TOOL_TIERS, BREEZE_MCP_TOOL_NAMES } from './aiAgentSdkTools';
import { AGENT_CAPABILITIES, TOOL_CAPABILITY } from './aiAgents/agentToolCatalog';
import { toolInputSchemas } from './aiToolSchemas';
import { TOOL_PERMISSIONS } from './aiGuardrails';

describe('export_dataset registration', () => {
  it('1. is in the aiTools registry', () => {
    expect(aiTools.has('export_dataset')).toBe(true);
  });

  it('2. is in TOOL_TIERS at tier 1', () => {
    expect(TOOL_TIERS.export_dataset).toBe(1);
  });

  it('3. is mapped to the workspace capability, which exists', () => {
    expect(TOOL_CAPABILITY.export_dataset).toBe('workspace');
    expect(AGENT_CAPABILITIES.map((c) => c.id)).toContain('workspace');
    expect(AGENT_CAPABILITIES.find((c) => c.id === 'workspace')?.tone).toBe('standard');
  });

  it('4a. is advertised under the SDK-prefixed MCP name', () => {
    // BREEZE_MCP_TOOL_NAMES is `Object.keys(TOOL_TIERS).map(n => 'mcp__breeze__' + n)`
    // (aiAgentSdkTools.ts:335), so the bare name never appears — and this
    // assertion alone only re-tests TOOL_TIERS, which is why 4b exists.
    expect(BREEZE_MCP_TOOL_NAMES).toContain('mcp__breeze__export_dataset');
  });

  it('4b. has a real tool() declaration inside createBreezeMcpServer', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('./aiAgentSdkTools.ts', import.meta.url), 'utf8'));
    const server = source.slice(source.indexOf('export function createBreezeMcpServer'));
    expect(server).toContain("'export_dataset'");
    expect(server).toContain("makeHandler('export_dataset'");
  });

  it('5. has a Zod input schema', () => {
    expect('export_dataset' in toolInputSchemas).toBe(true);
    const parsed = toolInputSchemas.export_dataset!.safeParse({ dataset: 'event_logs', format: 'csv' });
    expect(parsed.success).toBe(true);
    expect(toolInputSchemas.export_dataset!.safeParse({ dataset: 'nope' }).success).toBe(false);
  });

  it('6. has an RBAC permission entry', () => {
    expect(TOOL_PERMISSIONS.export_dataset).toEqual({ resource: 'devices', action: 'read' });
  });
});
