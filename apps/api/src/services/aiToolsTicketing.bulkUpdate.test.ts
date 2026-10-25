import { beforeEach, describe, expect, it, vi } from 'vitest';

const T1 = '00000000-0000-4000-8000-000000000001';
const ORG = '00000000-0000-4000-8000-000000000010';

const { bulk, mockLimit, mockSelect } = vi.hoisted(() => {
  const mockLimit = vi.fn<() => Promise<unknown[]>>(() => Promise.resolve([]));
  const mockSelect = vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: mockLimit })) })) }));
  return { bulk: { bulkUpdateTickets: vi.fn(async () => JSON.stringify({ updated: 1 })) }, mockLimit, mockSelect };
});

vi.mock('../db', () => ({ db: { select: mockSelect } }));
vi.mock('../middleware/auth', () => ({
  isAiAgentPrincipal: (auth: { principal?: { kind?: string } }) => auth?.principal?.kind === 'ai_agent',
}));
vi.mock('../routes/tickets/siteScope', () => ({
  deviceInSiteScope: vi.fn(async () => true),
  ticketSiteScopeCondition: vi.fn(() => undefined),
}));
vi.mock('./aiToolsTicketBulk', () => bulk);

import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { registerTicketingTools } from './aiToolsTicketing';
import { validateToolInput } from './aiToolSchemas';

const tool = (() => {
  const tools = new Map<string, AiTool>();
  registerTicketingTools(tools);
  return tools.get('manage_tickets')!;
})();

function makeAuth(over: Partial<AuthContext> = {}): AuthContext {
  return {
    principal: { kind: 'user_session' },
    user: { id: 'user-1', email: 't@example.com', name: 'Tech', isPlatformAdmin: false },
    token: {} as AuthContext['token'],
    partnerId: 'partner-1',
    orgId: null,
    scope: 'partner',
    accessibleOrgIds: [ORG],
    orgCondition: vi.fn(() => undefined),
    canAccessOrg: vi.fn(() => true),
    ...over,
  } as AuthContext;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLimit.mockResolvedValue([]);
});

describe('manage_tickets bulk_update wiring (W06)', () => {
  it('is advertised: action enum, ticketIds property, description names it within budget', () => {
    const schema = tool.definition.input_schema as { properties: Record<string, { enum?: string[]; type?: unknown }> };
    expect(schema.properties.action!.enum).toContain('bulk_update');
    expect(schema.properties.ticketIds).toBeDefined();
    expect(tool.definition.description).toContain('bulk_update');
    expect((tool.definition.description ?? '').length).toBeLessThanOrEqual(300);
  });

  it('the Zod schema accepts bulk_update and a null assigneeId', () => {
    expect(validateToolInput('manage_tickets', { action: 'bulk_update', ticketIds: [T1], assigneeId: null }).success).toBe(true);
  });

  it('refuses an ai_agent principal and never reaches the bulk module', async () => {
    const agent = makeAuth({ principal: { kind: 'ai_agent', agentId: 'a', runId: 'r' } as AuthContext['principal'] });
    const res = JSON.parse(await tool.handler({ action: 'bulk_update', ticketIds: [T1], priority: 'high' }, agent));
    expect(res).toEqual({ error: 'agent_principal_unsupported_action', action: 'bulk_update' });
    expect(bulk.bulkUpdateTickets).not.toHaveBeenCalled();
  });

  it('hands the input, the typed user actor and the org/site-scoped ticket lookup to the bulk module', async () => {
    await tool.handler({ action: 'bulk_update', ticketIds: [T1], priority: 'high' }, makeAuth());
    expect(bulk.bulkUpdateTickets).toHaveBeenCalledTimes(1);
    const [input, deps] = bulk.bulkUpdateTickets.mock.calls[0] as unknown as [Record<string, unknown>, {
      actor: unknown; auth: unknown; findTicket: (id: string) => Promise<unknown>;
    }];
    expect(input).toMatchObject({ ticketIds: [T1], priority: 'high' });
    expect(deps.actor).toEqual({ kind: 'user', userId: 'user-1', name: 'Tech' });
    expect(deps.auth).toEqual({ scope: 'partner', partnerId: 'partner-1' });
    // The lookup is findTicketWithAccess: an unreachable ticket resolves to null.
    expect(await deps.findTicket(T1)).toBeNull();
    mockLimit.mockResolvedValueOnce([{ id: T1, orgId: ORG, deviceId: null, deletedAt: null }]);
    expect(await deps.findTicket(T1)).toMatchObject({ id: T1, orgId: ORG });
  });
});
