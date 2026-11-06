/**
 * #11181 contract: every approval-class (Tier-3) AI tool that takes an org argument says
 * which org its intent is filed in. A new tool with an `orgId` (or `org_id`) argument must
 * be added to `INTENT_ORG_ARGUMENT` (the argument names the org it changes), to
 * `ORG_ARGUMENT_NOT_TARGET` with the reason it does not, or be a row-resolved design tool.
 * Otherwise its intent silently lands in the session org while it changes another.
 */
import { describe, expect, it } from 'vitest';
import { aiTools } from '../aiTools';
import { TIER3_FOUR_EYES_ACTIONS, TIER3_INPUT_AWARE_ACTIONS, TIER3_SUPERVISED_ACTIONS } from '../aiGuardrails';
import { AI_DESIGN_INTENT_TOOLS } from './aiDesignIntentTarget';
import { INTENT_ORG_ARGUMENT, ORG_ARGUMENT_NOT_TARGET } from './intentTargetOrg';

const ORG_ARGS = ['orgId', 'org_id'] as const;

function schemaProps(toolName: string): Record<string, unknown> {
  const schema = aiTools.get(toolName)?.definition.input_schema as { properties?: Record<string, unknown> } | undefined;
  return schema?.properties ?? {};
}

function tier3Actions(toolName: string): Set<string> {
  return new Set([...(TIER3_SUPERVISED_ACTIONS[toolName] ?? []), ...(TIER3_FOUR_EYES_ACTIONS[toolName] ?? [])]);
}

function hasTier3(toolName: string): boolean {
  return aiTools.get(toolName)?.tier === 3 || tier3Actions(toolName).size > 0 || TIER3_INPUT_AWARE_ACTIONS.has(toolName);
}

describe('intent target org contract (#11181)', () => {
  it('every Tier-3 tool with an org argument is classified', () => {
    const unclassified = [...aiTools.keys()].filter((name) => hasTier3(name)
      && ORG_ARGS.some((arg) => arg in schemaProps(name))
      && !(name in INTENT_ORG_ARGUMENT) && !(name in ORG_ARGUMENT_NOT_TARGET) && !AI_DESIGN_INTENT_TOOLS.has(name));
    expect(unclassified).toEqual([]);
  });

  it.each(Object.entries(INTENT_ORG_ARGUMENT))('%s: the argument exists and every listed action files an intent', (toolName, entry) => {
    expect(aiTools.has(toolName)).toBe(true);
    expect(schemaProps(toolName)).toHaveProperty(entry.arg);
    expect(hasTier3(toolName)).toBe(true);
    if (entry.actions !== 'all' && aiTools.get(toolName)?.tier !== 3) {
      const tier3 = tier3Actions(toolName);
      expect(entry.actions.filter((action) => !tier3.has(action))).toEqual([]);
    }
  });

  it('every not-target entry is a real tool with an org argument and a reason', () => {
    for (const [toolName, reason] of Object.entries(ORG_ARGUMENT_NOT_TARGET)) {
      expect(aiTools.has(toolName), toolName).toBe(true);
      expect(ORG_ARGS.some((arg) => arg in schemaProps(toolName)), toolName).toBe(true);
      expect(reason.length, toolName).toBeGreaterThan(10);
    }
  });

  it('the design tools are row-resolved, not argument-resolved', () => {
    for (const name of AI_DESIGN_INTENT_TOOLS) expect(INTENT_ORG_ARGUMENT).not.toHaveProperty(name);
  });
});
