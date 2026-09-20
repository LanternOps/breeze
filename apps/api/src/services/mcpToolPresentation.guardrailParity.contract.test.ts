/**
 * B-W01 contract: MCP annotations may be STRICTER than checkGuardrails,
 * never LOOSER. For every registered tool × declared action:
 *   - if guardrails say the resolution is NOT read-only, the tool's
 *     readOnlyHint must be false;
 *   - any mutation must be destructive and open-world;
 *   - tier 3 must still be destructive, independently of the hint rule.
 * No vi.mock.
 */
import { describe, expect, it } from 'vitest';
import { aiTools } from './aiToolNames';
import './aiTools';
import { getToolDomain, getToolTier } from './aiTools';
import { checkGuardrails, isReadOnlyResolution, TOOL_ACTION_INPUT_KEYS } from './aiGuardrails';
import { toolActionEnum } from './aiToolActions';
import { buildMcpToolPresentation } from './mcpToolPresentation';

describe('MCP annotations vs checkGuardrails (never looser)', () => {
  it('never advertises a looser hint than the guardrails enforce', () => {
    const looser: string[] = [];
    for (const [name, tool] of aiTools) {
      const p = buildMcpToolPresentation(tool.definition, getToolTier(name), getToolDomain(name));
      const targets: (string | undefined)[] = toolActionEnum(name) ?? [undefined];
      expect(p.annotations.destructiveHint, name).toBe(!p.annotations.readOnlyHint);
      expect(p.annotations.openWorldHint, name).toBe(!p.annotations.readOnlyHint || getToolDomain(name) === 'integrations');
      expect(p.annotations.idempotentHint, name).toBe(p.annotations.readOnlyHint);
      for (const action of targets) {
        const check = checkGuardrails(name, action ? { [TOOL_ACTION_INPUT_KEYS[name] ?? 'action']: action } : {});
        if (check.tier === 4) continue;                         // blocked tools never list
        const guardReadOnly = isReadOnlyResolution(name, check);
        if (!guardReadOnly && !p.annotations.destructiveHint) looser.push(`${name}:${action} mutates but claims additive-only`);
        if (!guardReadOnly && !p.annotations.openWorldHint) looser.push(`${name}:${action} mutates but claims closed-world`);
        if (!guardReadOnly && p.annotations.readOnlyHint) looser.push(`${name}${action ? ':' + action : ''} claims readOnly but guardrails say mutation`);
        if (check.tier >= 3 && !p.annotations.destructiveHint) looser.push(`${name}${action ? ':' + action : ''} is tier 3 but not destructiveHint`);
      }
    }
    expect(looser).toEqual([]);
  });
  it('has a populated registry', () => { expect(aiTools.size).toBeGreaterThan(150); });
});
