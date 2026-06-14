import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));
vi.mock('./ticketService', () => ({
  createTicket: vi.fn(async () => ({ id: 't-new' })),
  changeTicketStatus: vi.fn(async () => ({ id: 't1', status: 'resolved' })),
  assignTicket: vi.fn(async () => ({ id: 't1', assignedTo: 'u2' })),
  addTicketComment: vi.fn(async () => ({ comment: { id: 'c1' } })),
}));

import { db } from '../db';
import * as ticketService from './ticketService';
import { registerTicketingTools } from './aiToolsTicketing';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

const mockDb = db as unknown as { select: ReturnType<typeof vi.fn> };

function handlerFor(name: string): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerTicketingTools(reg);
  return reg.get(name)!.handler;
}

function makeAuth(allowedSiteIds?: string[]): AuthContext {
  return {
    user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: {} as any,
    partnerId: null,
    orgId: 'org-1',
    scope: 'organization',
    accessibleOrgIds: ['org-1'],
    orgCondition: () => undefined,
    canAccessOrg: () => true,
    allowedSiteIds,
    canAccessSite: (s: string | null) => (!allowedSiteIds ? true : !!s && allowedSiteIds.includes(s)),
  } as unknown as AuthContext;
}

// Mock select so that:
//  - call 1 (findTicketWithAccess ticket load) -> returns the given ticket row
//  - call 2 (deviceInSiteScope device load)   -> returns { siteId }
function mockTicketThenDevice(ticket: Record<string, unknown>, deviceSiteId: string | null) {
  let call = 0;
  mockDb.select.mockImplementation(() => {
    call++;
    if (call === 1) {
      return { from: () => ({ where: () => ({ limit: () => Promise.resolve([ticket]) }) }) };
    }
    return { from: () => ({ where: () => ({ limit: () => Promise.resolve([{ siteId: deviceSiteId }]) }) }) };
  });
}

const handler = () => handlerFor('manage_tickets');

describe('manage_tickets — by-id site scoping (out-of-site device denied)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('get denies a ticket whose device is in a forbidden site', async () => {
    mockTicketThenDevice({ id: 't1', orgId: 'org-1', deviceId: 'd1' }, 'site-B');
    const r = await handler()({ action: 'get', ticketId: 't1' }, makeAuth(['site-A']));
    expect(JSON.parse(r).error).toBe('Ticket not found');
  });

  it('comment denies + does not mutate for an out-of-site device ticket', async () => {
    mockTicketThenDevice({ id: 't1', orgId: 'org-1', deviceId: 'd1' }, 'site-B');
    const r = await handler()(
      { action: 'comment', ticketId: 't1', content: 'hi' },
      makeAuth(['site-A'])
    );
    expect(JSON.parse(r).error).toBe('Ticket not found');
    expect(ticketService.addTicketComment).not.toHaveBeenCalled();
  });

  it('assign denies + does not mutate for an out-of-site device ticket', async () => {
    mockTicketThenDevice({ id: 't1', orgId: 'org-1', deviceId: 'd1' }, 'site-B');
    const r = await handler()(
      { action: 'assign', ticketId: 't1', assigneeId: 'u2' },
      makeAuth(['site-A'])
    );
    expect(JSON.parse(r).error).toBe('Ticket not found');
    expect(ticketService.assignTicket).not.toHaveBeenCalled();
  });

  it('update_status denies + does not mutate for an out-of-site device ticket', async () => {
    mockTicketThenDevice({ id: 't1', orgId: 'org-1', deviceId: 'd1' }, 'site-B');
    const r = await handler()(
      { action: 'update_status', ticketId: 't1', status: 'resolved', resolutionNote: 'done' },
      makeAuth(['site-A'])
    );
    expect(JSON.parse(r).error).toBe('Ticket not found');
    expect(ticketService.changeTicketStatus).not.toHaveBeenCalled();
  });
});

describe('manage_tickets — by-id site scoping (in-site device allowed)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('get succeeds when the device is in an allowed site', async () => {
    mockTicketThenDevice({ id: 't1', orgId: 'org-1', deviceId: 'd1' }, 'site-A');
    const r = await handler()({ action: 'get', ticketId: 't1' }, makeAuth(['site-A']));
    const parsed = JSON.parse(r);
    expect(parsed.error).toBeUndefined();
    expect(parsed.ticket.id).toBe('t1');
  });

  it('update_status mutates when the device is in an allowed site', async () => {
    mockTicketThenDevice({ id: 't1', orgId: 'org-1', deviceId: 'd1' }, 'site-A');
    const r = await handler()(
      { action: 'update_status', ticketId: 't1', status: 'resolved', resolutionNote: 'done' },
      makeAuth(['site-A'])
    );
    expect(JSON.parse(r).error).toBeUndefined();
    expect(ticketService.changeTicketStatus).toHaveBeenCalled();
  });
});

describe('manage_tickets — by-id site scoping (null-device ticket = org scope)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('get on a deviceless ticket stays accessible to a site-restricted caller', async () => {
    // Only the ticket load happens; deviceInSiteScope is skipped for null deviceId.
    mockDb.select.mockReturnValue({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([{ id: 't1', orgId: 'org-1', deviceId: null }]) }) }),
    });
    const r = await handler()({ action: 'get', ticketId: 't1' }, makeAuth(['site-A']));
    const parsed = JSON.parse(r);
    expect(parsed.error).toBeUndefined();
    expect(parsed.ticket.id).toBe('t1');
  });

  it('update_status on a deviceless ticket mutates for a site-restricted caller', async () => {
    mockDb.select.mockReturnValue({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([{ id: 't1', orgId: 'org-1', deviceId: null }]) }) }),
    });
    const r = await handler()(
      { action: 'update_status', ticketId: 't1', status: 'resolved', resolutionNote: 'done' },
      makeAuth(['site-A'])
    );
    expect(JSON.parse(r).error).toBeUndefined();
    expect(ticketService.changeTicketStatus).toHaveBeenCalled();
  });
});

describe('manage_tickets — unrestricted caller unaffected', () => {
  beforeEach(() => vi.clearAllMocks());

  it('get succeeds for an unrestricted caller even with a device-bound ticket', async () => {
    // allowedSiteIds undefined → deviceInSiteScope short-circuits true (no device load).
    mockDb.select.mockReturnValue({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([{ id: 't1', orgId: 'org-1', deviceId: 'd1' }]) }) }),
    });
    const r = await handler()({ action: 'get', ticketId: 't1' }, makeAuth(undefined));
    const parsed = JSON.parse(r);
    expect(parsed.error).toBeUndefined();
    expect(parsed.ticket.id).toBe('t1');
  });
});
