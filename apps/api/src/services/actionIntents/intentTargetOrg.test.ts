import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ resolveDesign: vi.fn() }));

vi.mock('./aiDesignIntentTarget', () => ({
  AI_DESIGN_INTENT_TOOLS: new Set(['manage_ai_agent_schedules', 'manage_fleet_designs']),
  resolveAiDesignIntentTarget: h.resolveDesign,
}));

import { INTENT_ORG_ARGUMENT, ORG_ARGUMENT_NOT_TARGET, argumentTargetOrg, decideIntentOrg, resolveIntentTarget, INTENT_ORG_OUT_OF_REACH } from './intentTargetOrg';

const ORG_A = '00000000-0000-4000-8000-0000000000a1';
const ORG_B = '00000000-0000-4000-8000-0000000000b1';
const ORG_X = '00000000-0000-4000-8000-0000000000f9';
const PARTNER = '00000000-0000-4000-8000-0000000000c1';

const reach = (...orgIds: string[]) => ({ canAccessOrg: (id: string) => orgIds.includes(id), partnerId: PARTNER });

beforeEach(() => {
  h.resolveDesign.mockReset();
});

describe('argumentTargetOrg (#11181)', () => {
  it('reads orgId, and org_id for the tools that spell it that way', () => {
    expect(argumentTargetOrg('manage_org_portal_settings', { action: 'set_sensitive_access', orgId: ORG_B })).toBe(ORG_B);
    expect(argumentTargetOrg('manage_peripheral_policy', { action: 'create', org_id: ORG_B })).toBe(ORG_B);
    expect(argumentTargetOrg('configure_network_baseline', { org_id: ORG_B })).toBe(ORG_B);
  });

  it('no org argument names no target: the call is the session org\'s, or partner-wide', () => {
    expect(argumentTargetOrg('manage_billing_settings', { action: 'update_partner' })).toBeNull();
    expect(argumentTargetOrg('manage_org_portal_settings', { action: 'set_sensitive_access', orgId: 42 })).toBeNull();
    expect(argumentTargetOrg('manage_org_portal_settings', { action: 'set_sensitive_access', orgId: '' })).toBeNull();
  });

  it('a tool whose org argument never names the changed org never moves the intent', () => {
    const only = Object.keys(ORG_ARGUMENT_NOT_TARGET).filter((tool) => !(tool in INTENT_ORG_ARGUMENT));
    expect(only).toEqual(expect.arrayContaining(['manage_invoices', 'manage_tickets', 'send_endpoint_message', 'manage_ai_agents']));
    for (const tool of only) expect(argumentTargetOrg(tool, { action: 'void', orgId: ORG_B, org_id: ORG_B })).toBeNull();
  });

  it('within a tool, only the listed actions move: a row-identified write of the same tool does not', () => {
    expect(argumentTargetOrg('manage_tenant_variables', { action: 'create', orgId: ORG_B })).toBe(ORG_B);
    expect(argumentTargetOrg('manage_tenant_variables', { action: 'delete', orgId: ORG_B, variableId: 'v' })).toBeNull();
    expect(argumentTargetOrg('manage_tenant_variables', { action: 'create', ownerScope: 'partner', orgId: ORG_B })).toBeNull();
    expect(argumentTargetOrg('configure_network_baseline', { org_id: ORG_B, baseline_id: 'b' })).toBeNull();
    expect(argumentTargetOrg('manage_billing_settings', { action: 'update_org', orgId: ORG_B })).toBe(ORG_B);
    expect(argumentTargetOrg('manage_billing_settings', { action: 'update_partner', orgId: ORG_B })).toBeNull();
  });
});

describe('the `when` predicates (#11181)', () => {
  // Every org-or-partner create: a partner-owned row is partner-wide and stays in the session org.
  it.each([
    ['manage_configuration_policy', 'create'], ['manage_delivery', 'create_routing'], ['manage_software_policies', 'create'],
    ['manage_tenant_variables', 'create'], ['manage_ticket_forms', 'create'], ['manage_ticket_routing_rules', 'create'],
  ])('%s %s: org-owned moves, partner-owned does not', (tool, action) => {
    expect(argumentTargetOrg(tool, { action, orgId: ORG_B })).toBe(ORG_B);
    expect(argumentTargetOrg(tool, { action, ownerScope: 'organization', orgId: ORG_B })).toBe(ORG_B);
    expect(argumentTargetOrg(tool, { action, ownerScope: 'partner', orgId: ORG_B })).toBeNull();
  });

  it('configure_network_baseline: a create moves, an update of a named baseline does not', () => {
    expect(argumentTargetOrg('configure_network_baseline', { org_id: ORG_B, subnet: '10.0.0.0/24' })).toBe(ORG_B);
    expect(argumentTargetOrg('configure_network_baseline', { org_id: ORG_B, baseline_id: ORG_X })).toBeNull();
  });
});

describe('resolveIntentTarget + decideIntentOrg (#11181)', () => {
  it('set_sensitive_access names org B in reach: the intent is filed in org B', async () => {
    const target = await resolveIntentTarget('manage_org_portal_settings', { action: 'set_sensitive_access', orgId: ORG_B, flags: { showPatches: true } });
    expect(decideIntentOrg(target, reach(ORG_A, ORG_B))).toEqual({ kind: 'target', orgId: ORG_B });
    expect(h.resolveDesign).not.toHaveBeenCalled();
  });

  it('an org argument outside reach refuses: never filed in the session org', async () => {
    const target = await resolveIntentTarget('manage_org_portal_settings', { action: 'set_sensitive_access', orgId: ORG_X, flags: {} });
    expect(decideIntentOrg(target, reach(ORG_A, ORG_B))).toEqual({ kind: 'refuse', error: INTENT_ORG_OUT_OF_REACH });
    expect(INTENT_ORG_OUT_OF_REACH).toBe('Access denied to this organization');
  });

  it('no target keeps the session org', async () => {
    expect(decideIntentOrg(await resolveIntentTarget('manage_billing_settings', { action: 'update_partner' }), reach(ORG_A))).toEqual({ kind: 'session' });
  });

  it('a design row in reach moves the intent and carries its card detail', async () => {
    h.resolveDesign.mockResolvedValue({ orgId: ORG_B, partnerId: null, cardDetail: 'It covers 2 devices.' });
    const target = await resolveIntentTarget('manage_fleet_designs', { action: 'apply', reportRunId: 'r' });
    expect(decideIntentOrg(target, reach(ORG_A, ORG_B))).toEqual({ kind: 'target', orgId: ORG_B, cardDetail: 'It covers 2 devices.' });
  });

  it('a design ROW outside reach stays in the session org with no card detail: a foreign id reveals nothing', async () => {
    h.resolveDesign.mockResolvedValue({ orgId: ORG_X, partnerId: null, cardDetail: 'It covers 2 devices.' });
    const target = await resolveIntentTarget('manage_fleet_designs', { action: 'rollback', reportRunId: 'r' });
    expect(decideIntentOrg(target, reach(ORG_A))).toEqual({ kind: 'session' });
  });

  it('a design tool naming its org as an ARGUMENT outside reach refuses like any argument', async () => {
    h.resolveDesign.mockResolvedValue({ orgId: ORG_X, partnerId: null, fromArgument: true });
    const target = await resolveIntentTarget('manage_fleet_designs', { action: 'run', orgId: ORG_X });
    expect(decideIntentOrg(target, reach(ORG_A))).toEqual({ kind: 'refuse', error: INTENT_ORG_OUT_OF_REACH });
  });

  it("a partner baseline stays in the session org; its card detail only for the caller's own partner", async () => {
    h.resolveDesign.mockResolvedValue({ orgId: null, partnerId: PARTNER, cardDetail: 'Baseline.' });
    expect(decideIntentOrg(await resolveIntentTarget('manage_ai_agent_schedules', { action: 'delete', scheduleId: 's' }), reach(ORG_A)))
      .toEqual({ kind: 'session', cardDetail: 'Baseline.' });
    h.resolveDesign.mockResolvedValue({ orgId: null, partnerId: 'another', cardDetail: 'Baseline.' });
    expect(decideIntentOrg(await resolveIntentTarget('manage_ai_agent_schedules', { action: 'delete', scheduleId: 's' }), reach(ORG_A)))
      .toEqual({ kind: 'session' });
  });
});
