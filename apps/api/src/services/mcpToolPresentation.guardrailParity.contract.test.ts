/**
 * B-W01 contract: MCP annotations may be STRICTER than checkGuardrails,
 * never LOOSER. For every registered tool × declared action:
 *   - if guardrails say the resolution is NOT read-only, the tool's
 *     readOnlyHint must be false;
 *   - if guardrails resolve tier 3, destructiveHint must be true.
 * No vi.mock.
 */
import { describe, expect, it } from 'vitest';
import { aiTools } from './aiToolNames';
import './aiTools';
import { getToolDomain, getToolTier } from './aiTools';
import { checkGuardrails, isReadOnlyResolution } from './aiGuardrails';
import { buildMcpToolPresentation } from './mcpToolPresentation';

function actionsOf(schema: unknown): (string | undefined)[] {
  const values = (schema as { properties?: { action?: { enum?: unknown[] } } })?.properties?.action?.enum;
  const actions = Array.isArray(values) ? values.filter((v): v is string => typeof v === 'string') : [];
  return actions.length > 0 ? actions : [undefined];
}

describe('MCP annotations vs checkGuardrails (never looser)', () => {
  const looser: string[] = [];
  for (const [name, tool] of aiTools) {
    const p = buildMcpToolPresentation(tool.definition, getToolTier(name), getToolDomain(name));
    for (const action of actionsOf(tool.definition.input_schema)) {
      const check = checkGuardrails(name, action ? { action } : {});
      if (check.tier === 4) continue;                         // blocked tools never list
      const guardReadOnly = isReadOnlyResolution(name, check);
      if (!guardReadOnly && p.annotations.readOnlyHint) looser.push(`${name}${action ? ':' + action : ''} claims readOnly but guardrails say mutation`);
      if (check.tier >= 3 && !p.annotations.destructiveHint) looser.push(`${name}${action ? ':' + action : ''} is tier 3 but not destructiveHint`);
    }
  }
  it('has a populated registry', () => { expect(aiTools.size).toBeGreaterThan(150); });
  it('never advertises a looser hint than the guardrails enforce', () => { expect(looser).toEqual([]); });
});
