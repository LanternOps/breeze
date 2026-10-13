import { describe, it, expect, vi, beforeEach } from 'vitest';

const { timeEntryMocks } = vi.hoisted(() => ({
  timeEntryMocks: {
    createTimeEntry: vi.fn(),
    startTimer: vi.fn(),
    stopTimer: vi.fn(),
    updateTimeEntry: vi.fn(),
    readTimeEntryById: vi.fn(),
  },
}));

vi.mock('./timeEntryService', async () => {
  const actual = await vi.importActual<typeof import('./timeEntryService')>('./timeEntryService');
  return { ...actual, ...timeEntryMocks };
});

const billingPermissionMocks = vi.hoisted(() => ({ getUserPermissions: vi.fn() }));
vi.mock('./permissions', async () => ({
  ...await vi.importActual<typeof import('./permissions')>('./permissions'),
  getUserPermissions: billingPermissionMocks.getUserPermissions,
}));

const { mockLimit } = vi.hoisted(() => ({ mockLimit: vi.fn<() => Promise<unknown[]>>(() => Promise.resolve([])) }));
vi.mock('../db', () => ({
  db: { select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: mockLimit })) })) })) },
}));

vi.mock('../middleware/auth', () => ({
  siteAccessCheck: (allowed: string[]) => (siteId?: string | null) => !!siteId && allowed.includes(siteId),
  isAiAgentPrincipal: (a: { principal?: { kind?: string } }) => a?.principal?.kind === 'ai_agent',
}));

import { registerTicketingTools } from './aiToolsTicketing';
import { TimeEntryServiceError } from './timeEntryService';
import { toolInputSchemas } from './aiToolSchemas';
import type { AiTool } from './aiTools';
import type { AuthContext } from '../middleware/auth';

const ID = '33333333-3333-3333-3333-333333333333';
const TICKET_ID = '44444444-4444-4444-4444-444444444444';

const humanAuth = {
  principal: { kind: 'user_session' },
  user: { id: 'u-1', email: 'tech@example.com', name: 'Tech User', isPlatformAdmin: false },
  token: {} as never,
  partnerId: 'p-1',
  orgId: 'o-1',
  scope: 'partner',
  accessibleOrgIds: ['o-1'],
  orgCondition: vi.fn(() => undefined),
  canAccessOrg: vi.fn(() => true),
} as unknown as AuthContext;

const agentAuth = {
  ...humanAuth,
  principal: { kind: 'ai_agent', agentId: 'agent-1', runId: '77777777-7777-7777-7777-777777777777' },
  token: null,
} as unknown as AuthContext;

function getTool(): AiTool {
  const tools = new Map<string, AiTool>();
  registerTicketingTools(tools);
  return tools.get('manage_tickets')!;
}
async function run(input: Record<string, unknown>, a: AuthContext = humanAuth) {
  return JSON.parse(await getTool().handler({ action: 'update_time_entry', ...input }, a));
}

describe('manage_tickets update_time_entry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLimit.mockResolvedValue([]);
    billingPermissionMocks.getUserPermissions.mockResolvedValue(null);
    timeEntryMocks.readTimeEntryById.mockResolvedValue({ id: ID, ticketId: null });
    timeEntryMocks.updateTimeEntry.mockResolvedValue({ id: ID, orgId: 'o-1', currencyCode: 'USD', description: 'x' });
  });

  it('is registered in the action enum and the input schema', () => {
    const props = getTool().definition.input_schema.properties as Record<string, { enum?: string[] }>;
    expect(props.action!.enum).toContain('update_time_entry');
    expect(toolInputSchemas.manage_tickets!.safeParse({ action: 'update_time_entry', timeEntryId: ID, description: 'x' }).success).toBe(true);
  });

  it('requires timeEntryId', async () => {
    expect((await run({ description: 'x' })).error).toMatch(/timeEntryId/);
    expect(timeEntryMocks.updateTimeEntry).not.toHaveBeenCalled();
  });

  it('rejects hourlyRate (rate edits stay behind time_entries:manage_billing in REST/UI)', async () => {
    expect((await run({ timeEntryId: ID, hourlyRate: 1 })).error).toMatch(/hourlyRate/);
    expect(timeEntryMocks.updateTimeEntry).not.toHaveBeenCalled();
  });

  it('rejects an empty patch (the service would silently clear approval)', async () => {
    expect((await run({ timeEntryId: ID })).error).toMatch(/at least one field/i);
    expect(timeEntryMocks.updateTimeEntry).not.toHaveBeenCalled();
  });

  it('applies the REST validator: oversized description', async () => {
    expect((await run({ timeEntryId: ID, description: 'a'.repeat(10_001) })).error).toBeTruthy();
    expect(timeEntryMocks.updateTimeEntry).not.toHaveBeenCalled();
  });

  it('applies the REST validator: future start', async () => {
    const future = new Date(Date.now() + 2 * 86_400_000).toISOString();
    expect((await run({ timeEntryId: ID, startedAt: future })).error).toMatch(/future/i);
    expect(timeEntryMocks.updateTimeEntry).not.toHaveBeenCalled();
  });

  it('returns { error } for an unparseable date', async () => {
    expect((await run({ timeEntryId: ID, endedAt: 'not-a-date' })).error).toBeTruthy();
    expect(timeEntryMocks.updateTimeEntry).not.toHaveBeenCalled();
  });

  it('refuses an agent principal and never calls the service', async () => {
    const out = await run({ timeEntryId: ID, description: 'x' }, agentAuth);
    expect(out).toEqual({ error: 'agent_principal_requires_intent_release', action: 'update_time_entry' });
    expect(timeEntryMocks.updateTimeEntry).not.toHaveBeenCalled();
  });

  it('human happy path sends a sparse input with Date values and returns timeEntry + currencyCode', async () => {
    const out = await run({
      timeEntryId: ID,
      description: 'Replaced core switch',
      startedAt: '2026-09-16T10:00:00Z',
      endedAt: '2026-09-16T11:30:00Z',
      isBillable: false,
    });
    expect(out.timeEntry).toMatchObject({ id: ID });
    expect(out.currencyCode).toBe('USD');
    expect(timeEntryMocks.updateTimeEntry).toHaveBeenCalledTimes(1);
    expect(timeEntryMocks.updateTimeEntry).toHaveBeenCalledWith(
      ID,
      {
        description: 'Replaced core switch',
        startedAt: new Date('2026-09-16T10:00:00Z'),
        endedAt: new Date('2026-09-16T11:30:00Z'),
        isBillable: false,
      },
      expect.objectContaining({ userId: 'u-1', manageAll: false }),
    );
    const sent = timeEntryMocks.updateTimeEntry.mock.calls[0]![1] as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual(['description', 'endedAt', 'isBillable', 'startedAt']);
  });

  it('sends only description when only description is given', async () => {
    await run({ timeEntryId: ID, description: 'Replaced switch' });
    expect(timeEntryMocks.updateTimeEntry).toHaveBeenLastCalledWith(ID, { description: 'Replaced switch' }, expect.anything());
  });

  it('billed entry: description-only edit succeeds, time edit surfaces the 409 as { error }', async () => {
    timeEntryMocks.updateTimeEntry.mockImplementation(async (_id: string, input: Record<string, unknown>) => {
      if (input.startedAt !== undefined) {
        throw new TimeEntryServiceError('This entry has been invoiced; only its description can change', 409, 'ENTRY_BILLED');
      }
      return { id: ID, orgId: 'o-1', currencyCode: 'USD', billingStatus: 'billed' };
    });
    const blocked = await run({ timeEntryId: ID, startedAt: '2026-09-16T10:00:00Z' });
    expect(blocked.error).toMatch(/invoiced/);
    expect(blocked.timeEntry).toBeUndefined();
    const ok = await run({ timeEntryId: ID, description: 'Replaced switch' });
    expect(ok.timeEntry).toBeDefined();
  });

  it("pre-checks the entry's ticket scope when it has one", async () => {
    timeEntryMocks.readTimeEntryById.mockResolvedValue({ id: ID, ticketId: TICKET_ID });
    // mockLimit -> [] : ticket not in the caller's scope
    const out = await run({ timeEntryId: ID, description: 'x' });
    expect(out.error).toMatch(/not found/i);
    expect(timeEntryMocks.updateTimeEntry).not.toHaveBeenCalled();
  });

  it("proceeds when the entry's ticket is in scope", async () => {
    timeEntryMocks.readTimeEntryById.mockResolvedValue({ id: ID, ticketId: TICKET_ID });
    mockLimit.mockResolvedValue([{ id: TICKET_ID, orgId: 'o-1', deviceId: null }]);
    const out = await run({ timeEntryId: ID, description: 'x' });
    expect(out.timeEntry).toBeDefined();
  });

  it('returns not found when the entry does not exist', async () => {
    timeEntryMocks.readTimeEntryById.mockResolvedValue(null);
    expect((await run({ timeEntryId: ID, description: 'x' })).error).toMatch(/not found/i);
    expect(timeEntryMocks.updateTimeEntry).not.toHaveBeenCalled();
  });
});
