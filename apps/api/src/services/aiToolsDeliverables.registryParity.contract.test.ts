/**
 * W05 adds `manage_deliverables.apply_template` (the ONLY approval-gated action
 * in this family) and the `list_deliverable_templates` read tool. A tool/action
 * has SIX registration sites, and two of them fail CLOSED at runtime:
 *
 *   1. the tool definition's action enum (aiToolsDeliverables.ts)
 *   2. toolInputSchemas                (aiToolSchemas.ts)
 *   3. the SDK `tool()` block          (aiAgentSdkTools.ts)
 *   4. TOOL_PERMISSIONS                (aiGuardrails.ts)          — fails closed
 *   5. TOOL_CAPABILITY                 (aiAgents/agentToolCatalog.ts) — fails closed
 *   6. the pinned parity list          (agentToolCatalog.categoryParity.test.ts)
 *
 * No vi.mock here: this needs the REAL registries.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { registerDeliverableTools } from './aiToolsDeliverables';
import { toolInputSchemas } from './aiToolSchemas';
import { TOOL_PERMISSIONS, TIER3_ACTIONS, TIER2_READONLY_TOOLS } from './aiGuardrails';
import { TOOL_CAPABILITY } from './aiAgents/agentToolCatalog';
import type { AiTool } from './aiTools';

function registry(): Map<string, AiTool> {
  const map = new Map<string, AiTool>();
  registerDeliverableTools(map);
  return map;
}

function definitionActions(): string[] {
  const tool = registry().get('manage_deliverables');
  if (!tool) throw new Error('manage_deliverables is not registered');
  const props = tool.definition.input_schema.properties as Record<string, { enum?: string[] }>;
  if (!props.action?.enum) throw new Error('manage_deliverables definition has no action enum');
  return props.action.enum;
}

describe('deliverable template tool registration parity (#5573 W05)', () => {
  it('registers list_deliverable_templates alongside the W02 tools', () => {
    const map = registry();
    expect(map.has('list_deliverable_templates')).toBe(true);
    expect(map.has('manage_deliverables')).toBe(true);
  });

  it('apply_template is one of the definition actions', () => {
    expect(definitionActions()).toContain('apply_template');
  });

  it('every definition action is in the central Zod schema', () => {
    const schema = toolInputSchemas.manage_deliverables as unknown as { shape: { action: { options: readonly string[] } } };
    expect([...schema.shape.action.options].sort()).toEqual([...definitionActions()].sort());
  });

  it('every definition action has a TOOL_PERMISSIONS entry', () => {
    const perms = TOOL_PERMISSIONS.manage_deliverables as Record<string, unknown>;
    expect(definitionActions().filter((a) => !(a in perms))).toEqual([]);
  });

  it('apply_template is approval-gated (Tier 3)', () => {
    expect(TIER3_ACTIONS.manage_deliverables ?? []).toContain('apply_template');
  });

  it('the SDK tool registration carries apply_template', () => {
    const src = readFileSync(new URL('./aiAgentSdkTools.ts', import.meta.url), 'utf8');
    const start = src.indexOf("      'manage_deliverables',");
    expect(start, 'manage_deliverables is not registered in aiAgentSdkTools.ts').toBeGreaterThan(-1);
    expect(src.slice(start, start + 2000)).toContain("'apply_template'");
  });

  it('the SDK tool registration carries list_deliverable_templates', () => {
    const src = readFileSync(new URL('./aiAgentSdkTools.ts', import.meta.url), 'utf8');
    expect(src).toContain("      'list_deliverable_templates',");
  });

  it('list_deliverable_templates is a read tool with a schema, a permission and a capability', () => {
    expect('list_deliverable_templates' in toolInputSchemas).toBe(true);
    expect(TOOL_PERMISSIONS.list_deliverable_templates).toEqual({ resource: 'contracts', action: 'read' });
    expect(TIER2_READONLY_TOOLS.has('list_deliverable_templates')).toBe(true);
    // Site 5 fails closed: an unmapped tool is invisible to agent tool selection.
    expect(TOOL_CAPABILITY.list_deliverable_templates).toBe('business');
  });
});
