import { describe, expect, it } from 'vitest';
import { TOOL_TIERS } from './aiAgentSdkTools';
import { checkGuardrails, isReadOnlyResolution, requiredPermissionsForTool } from './aiGuardrails';
import { isMfaGatedToolAction } from './aiToolMfaGate';
import { AGENT_HUMAN_ONLY_ACTIONS } from './aiToolExposure';
import { TOOL_RATE_LIMITS } from './aiToolRateLimits';
import { RAW_TEXT_FIELDS_BY_TOOL } from './aiToolOutput';
import { TOOL_CAPABILITY } from './aiAgents/agentToolCatalog';

const actions = [
  ['get_pax8_status', undefined, 1],
  ...['search', 'provision_details', 'dependencies', 'pricing'].map((action) => ['search_pax8_products', action, 1]),
  ...['list', 'drift'].map((action) => ['manage_pax8_subscriptions', action, 1]),
  ...['sync', 'link', 'unlink'].map((action) => ['manage_pax8_subscriptions', action, 3]),
  ...['list', 'get', 'preview'].map((action) => ['manage_pax8_orders', action, 1]),
  ...['create_draft', 'add_line', 'update_line', 'remove_line'].map((action) => ['manage_pax8_orders', action, 2]),
  ['manage_pax8_orders', 'preflight', 3],
  ['manage_pax8_orders', 'submit', 3],
  ['manage_pax8_orders', 'reconcile', 3],
] as Array<[string, string | undefined, number]>;
const tools = ['get_pax8_status', 'search_pax8_products', 'manage_pax8_subscriptions', 'manage_pax8_orders'] as const;

describe('W15 Pax8 guardrail classes', () => {
  it.each(actions)('%s:%s resolves to W15 tier %s', (tool, action, tier) => {
    const result = checkGuardrails(tool, action ? { action } : {});
    expect(result).toMatchObject({ tier, allowed: true, requiresApproval: tier === 3 });
    expect(isReadOnlyResolution(tool, result)).toBe(tier === 1);
    if (tier === 3) expect(result).toHaveProperty('approvalScope', action === 'submit' ? 'four_eyes' : 'supervised');
    else expect(result.approvalScope).toBeUndefined();
  });

  it.each(actions)('%s:%s requires billing:manage', (tool, action) => {
    expect(requiredPermissionsForTool(tool, action ? { action } : {})).toEqual([{ resource: 'billing', action: 'manage' }]);
  });

  it.each(actions)('%s:%s gates every write with MFA and leaves reads ungated', (tool, action, tier) => {
    expect(isMfaGatedToolAction(tool, action)).toBe(tier !== 1);
  });

  it.each(tools)('%s has base tier 1 and business capability', (tool) => {
    expect(TOOL_TIERS[tool as keyof typeof TOOL_TIERS]).toBe(1);
    expect(TOOL_CAPABILITY[tool]).toBe('business');
  });

  it.each(actions.filter(([, , tier]) => tier !== 1))('%s:%s uses its reviewed agent exposure', (tool, action) => {
    expect(AGENT_HUMAN_ONLY_ACTIONS.has(`${tool}:${action}`)).toBe(tool === 'manage_pax8_orders' && action === 'submit');
  });

  it.each(tools)('%s fences vendor-authored term and SKU text', (tool) => {
    for (const field of ['commitmentTerm', 'billingTerm', 'catalogSku']) {
      expect(RAW_TEXT_FIELDS_BY_TOOL[tool]?.has(field), `${tool}.${field}`).toBe(true);
    }
  });

  it('limits all Pax8 tools tool-wide', () => {
    expect(TOOL_RATE_LIMITS.search_pax8_products).toEqual({ limit: 30, windowSeconds: 300 });
    expect(TOOL_RATE_LIMITS.get_pax8_status).toEqual({ limit: 30, windowSeconds: 300 });
    expect(TOOL_RATE_LIMITS.manage_pax8_orders).toEqual({ limit: 30, windowSeconds: 300 });
    expect(TOOL_RATE_LIMITS.manage_pax8_subscriptions).toEqual({ limit: 10, windowSeconds: 300 });
  });
});
