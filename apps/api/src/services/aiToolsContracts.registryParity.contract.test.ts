/**
 * #3205 W03: `manage_contracts` has FOUR registration sites, and an action
 * present in fewer than four is either invisible or FAIL-CLOSED DENIED:
 *
 *   1. aiToolsContracts.ts definition enum + MANAGE_CONTRACTS_REQUIRED + switch
 *   2. aiToolSchemas.ts toolInputSchemas.manage_contracts.action
 *   3. aiAgentSdkTools.ts tool('manage_contracts', …) action enum
 *   4. aiGuardrails.ts TOOL_PERMISSIONS.manage_contracts
 *
 * Site 4 is the dangerous one: a missing entry denies with
 * `Unknown action "<x>" for tool "manage_contracts"` (aiGuardrails.ts:1861-1870),
 * which reads like a permissions bug rather than a registration bug.
 *
 * Table-driven over EVERY action, so the next one cannot drift either. Site 3's
 * enum lives inside a tool() factory call and is not importable, so it is read
 * from the source text — the extractor throws rather than silently matching
 * nothing if that block is restructured.
 *
 * NOTE: no vi.mock — this suite needs the REAL registries, same rationale as
 * aiGuardrails.readonly.contract.test.ts and aiAgentSdkTools.registryParity.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import { registerContractTools } from './aiToolsContracts';
import { toolInputSchemas } from './aiToolSchemas';
import { TOOL_PERMISSIONS, requiredPermissionsForTool } from './aiGuardrails';
import type { AiTool } from './aiTools';

function definitionActions(): string[] {
  const map = new Map<string, AiTool>();
  registerContractTools(map);
  const tool = map.get('manage_contracts');
  if (!tool) throw new Error('manage_contracts is not registered');
  const props = tool.definition.input_schema.properties as Record<string, { enum?: string[] }>;
  const actions = props.action?.enum;
  if (!actions) throw new Error('manage_contracts definition has no action enum');
  return actions;
}

function centralSchemaActions(): string[] {
  const schema = toolInputSchemas.manage_contracts as unknown as {
    shape: { action: { options: readonly string[] } };
  };
  return [...schema.shape.action.options];
}

function sdkActions(): string[] {
  const src = readFileSync(new URL('./aiAgentSdkTools.ts', import.meta.url), 'utf8');
  const toolStart = src.indexOf("      'manage_contracts',");
  if (toolStart < 0) throw new Error("tool('manage_contracts', …) block not found in aiAgentSdkTools.ts");
  const enumStart = src.indexOf('action: z.enum([', toolStart);
  const enumEnd = src.indexOf(']),', enumStart);
  if (enumStart < 0 || enumEnd < 0) throw new Error('manage_contracts action enum not found in aiAgentSdkTools.ts');
  return [...src.slice(enumStart, enumEnd).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
}

function guardrailActions(): string[] {
  const entry = TOOL_PERMISSIONS.manage_contracts as Record<string, { resource: string; action: string }>;
  return Object.keys(entry);
}

const ACTIONS = definitionActions();

describe('manage_contracts four-site registry parity (#3205 W03)', () => {
  it('registers update_line', () => {
    expect(ACTIONS).toContain('update_line');
  });

  it.each(ACTIONS)('%s is present at every one of the four sites', (action) => {
    expect(centralSchemaActions()).toContain(action);
    expect(sdkActions()).toContain(action);
    expect(guardrailActions()).toContain(action);
  });

  it.each([
    ['central schema', centralSchemaActions],
    ['SDK tool enum', sdkActions],
    ['guardrail permissions', guardrailActions],
  ])('%s advertises no action the tool cannot dispatch', (_name, read) => {
    expect([...read()].sort()).toEqual([...ACTIONS].sort());
  });

  it('update_line resolves to contracts:write, not contracts:manage', () => {
    const entry = TOOL_PERMISSIONS.manage_contracts as Record<string, { resource: string; action: string }>;
    expect(entry.update_line).toEqual({ resource: 'contracts', action: 'write' });
    expect(requiredPermissionsForTool('manage_contracts', { action: 'update_line' }))
      .toEqual([{ resource: 'contracts', action: 'write' }]);
  });

  // The fail-closed path site 4 protects: an action with no TOOL_PERMISSIONS
  // entry resolves to no requirements at all and is denied with
  // `Unknown action "<x>" for tool "manage_contracts"` (aiGuardrails.ts:1861-1870).
  it('denies an action that is not registered in TOOL_PERMISSIONS', () => {
    expect(requiredPermissionsForTool('manage_contracts', { action: 'invented_action' })).toBeNull();
  });
});
