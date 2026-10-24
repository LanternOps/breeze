import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

vi.mock('./ticketRouting/service', () => ({
  listRoutingRules: vi.fn(),
  testRoutingRules: vi.fn(),
  createRoutingRule: vi.fn(),
  updateRoutingRule: vi.fn(),
  reorderRoutingRules: vi.fn(),
  deleteRoutingRule: vi.fn(),
  TicketRoutingError: class TicketRoutingError extends Error {
    constructor(message: string, readonly status: number, readonly code: string) { super(message); }
  },
}));
vi.mock('./partnerWideAccess', () => ({
  PartnerWideWriteDeniedError: class PartnerWideWriteDeniedError extends Error {
    constructor() { super('Managing partner-wide policies requires full partner access'); this.name = 'PartnerWideWriteDeniedError'; }
  },
}));

import * as svc from './ticketRouting/service';
import { PartnerWideWriteDeniedError } from './partnerWideAccess';
import { registerTicketRoutingTools } from './aiToolsTicketRouting';
import { toolInputSchemas } from './aiToolSchemas';

const ORG = '22222222-2222-4222-8222-222222222222';
const RULE = '33333333-3333-4333-8333-333333333333';
const auth = {
  scope: 'partner', orgId: null, partnerId: 'p-1', user: { id: 'u', email: 'u@x.test' },
  partnerOrgAccess: 'all', accessibleOrgIds: null, canAccessOrg: () => true,
} as unknown as AuthContext;

function tools(): Map<string, AiTool> {
  const m = new Map<string, AiTool>();
  registerTicketRoutingTools(m);
  return m;
}
const call = (name: string, input: Record<string, unknown>) =>
  tools().get(name)!.handler(input, auth).then((s) => JSON.parse(s));

describe('ticket routing AI tools (#8883)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('registers three tools at tiers 1, 1, 3 with short descriptions', () => {
    const m = tools();
    expect([...m.keys()]).toEqual(['list_ticket_routing_rules', 'test_ticket_routing_rule', 'manage_ticket_routing_rules']);
    expect([...m.values()].map((t) => t.tier)).toEqual([1, 1, 3]);
    for (const t of m.values()) expect(t.definition.description!.length).toBeLessThanOrEqual(300);
    const desc = m.get('manage_ticket_routing_rules')!.definition.description!;
    for (const a of ['create', 'update', 'reorder', 'delete']) expect(desc).toContain(a);
  });

  it('list passes the orgId through', async () => {
    vi.mocked(svc.listRoutingRules).mockResolvedValue([{ id: RULE }] as never);
    expect(await call('list_ticket_routing_rules', { orgId: ORG })).toEqual({ rules: [{ id: RULE }] });
    expect(await call('list_ticket_routing_rules', { limit: 0 })).toEqual({ rules: [] });
    expect(svc.listRoutingRules).toHaveBeenCalledWith(expect.objectContaining({ scope: 'partner', partnerId: 'p-1' }), { orgId: ORG });
  });

  it('test is a dry run through testRoutingRules', async () => {
    vi.mocked(svc.testRoutingRules).mockResolvedValue({ ruleId: null, ruleName: null, applied: {}, skipped: [] });
    const input = { orgId: ORG, source: 'email', subject: 'hi', requesterEmail: null };
    expect(await call('test_ticket_routing_rule', input)).toMatchObject({ ruleId: null });
    expect(svc.testRoutingRules).toHaveBeenCalledWith(expect.anything(), input);
    expect(svc.createRoutingRule).not.toHaveBeenCalled();
  });

  it('manage dispatches each action to the service', async () => {
    vi.mocked(svc.createRoutingRule).mockResolvedValue({ id: RULE } as never);
    vi.mocked(svc.updateRoutingRule).mockResolvedValue({ id: RULE } as never);
    vi.mocked(svc.reorderRoutingRules).mockResolvedValue({ updated: 1 });
    vi.mocked(svc.deleteRoutingRule).mockResolvedValue({ id: RULE, name: 'r', orgId: ORG, partnerId: null });
    await call('manage_ticket_routing_rules', { action: 'create', ownerScope: 'organization', orgId: ORG, name: 'r', setPriority: 'high' });
    expect(svc.createRoutingRule).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ ownerScope: 'organization', orgId: ORG, name: 'r' }));
    await call('manage_ticket_routing_rules', { action: 'update', ruleId: RULE, enabled: false });
    expect(svc.updateRoutingRule).toHaveBeenCalledWith(expect.anything(), RULE, { enabled: false });
    expect(await call('manage_ticket_routing_rules', { action: 'reorder', ids: [RULE] })).toMatchObject({ updated: 1 });
    expect(await call('manage_ticket_routing_rules', { action: 'delete', ruleId: RULE })).toMatchObject({ id: RULE });
  });

  it('PartnerWideWriteDeniedError surfaces as a tool error, not a throw', async () => {
    vi.mocked(svc.createRoutingRule).mockRejectedValue(new PartnerWideWriteDeniedError());
    const out = await call('manage_ticket_routing_rules', { action: 'create', ownerScope: 'partner', name: 'r', setPriority: 'high' });
    expect(out.error).toMatch(/partner-wide/i);
    expect(out.code).toBe('ACCESS_DENIED');
  });

  it('TicketRoutingError surfaces as a tool error', async () => {
    vi.mocked(svc.deleteRoutingRule).mockRejectedValue(new svc.TicketRoutingError('Routing rule not found', 404, 'NOT_FOUND'));
    expect(await call('manage_ticket_routing_rules', { action: 'delete', ruleId: RULE })).toEqual({ error: 'Routing rule not found', code: 'NOT_FOUND' });
  });

  it('has zod input schemas that parse valid input and reject a bad uuid', () => {
    for (const name of ['list_ticket_routing_rules', 'test_ticket_routing_rule', 'manage_ticket_routing_rules']) {
      expect(toolInputSchemas[name], name).toBeDefined();
    }
    expect(toolInputSchemas.list_ticket_routing_rules!.safeParse({ orgId: ORG }).success).toBe(true);
    expect(toolInputSchemas.list_ticket_routing_rules!.safeParse({ orgId: 'nope' }).success).toBe(false);
    expect(toolInputSchemas.test_ticket_routing_rule!.safeParse({ orgId: ORG, source: 'email', subject: 's', requesterEmail: null }).success).toBe(true);
    expect(toolInputSchemas.manage_ticket_routing_rules!.safeParse({ action: 'delete', ruleId: RULE }).success).toBe(true);
    expect(toolInputSchemas.manage_ticket_routing_rules!.safeParse({ action: 'delete', ruleId: 'nope' }).success).toBe(false);
  });
});
