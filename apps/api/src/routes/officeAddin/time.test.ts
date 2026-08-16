import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const PARTNER_ID = '11111111-1111-4111-8111-111111111111';
const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_ID = '99999999-9999-4999-8999-999999999999';
const TICKET_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ENTRY_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const PRIOR_ENTRY_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

type AuthState = { accessibleOrgIds: string[] | null };

const { authRef, hoisted } = vi.hoisted(() => ({
  authRef: { current: { accessibleOrgIds: null as string[] | null } as AuthState },
  hoisted: {
    getRunningTimer: vi.fn(),
    startTimer: vi.fn(),
    stopTimer: vi.fn(),
    createTimeEntry: vi.fn(),
  },
}));

vi.mock('../../middleware/officeAddinTechAuth', () => ({
  officeAddinTechAuthMiddleware: vi.fn(async (c: any, next: any) => {
    const accessibleOrgIds = authRef.current.accessibleOrgIds;
    c.set('officeAddinAuth', {
      userId: USER_ID,
      partnerId: PARTNER_ID,
      bindingId: 'binding-1',
      token: 'tok',
      user: { email: 'tech@partner.example', name: 'Tech Person' },
      accessibleOrgIds,
      partnerOrgAccess: accessibleOrgIds === null ? 'all' : 'selected',
      permissions: {},
      canAccessOrg: (orgId: string) => accessibleOrgIds === null || accessibleOrgIds.includes(orgId),
      canAccessSite: () => true,
    });
    return next();
  }),
  requireAddinCapability: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('../../services/timeEntryService', async () => {
  const actual = await vi.importActual<typeof import('../../services/timeEntryService')>(
    '../../services/timeEntryService'
  );
  return {
    ...actual,
    getRunningTimer: hoisted.getRunningTimer,
    startTimer: hoisted.startTimer,
    stopTimer: hoisted.stopTimer,
    createTimeEntry: hoisted.createTimeEntry,
  };
});

import { officeAddinTimeRoutes } from './time';
import { TimeEntryServiceError } from '../../services/timeEntryService';

function makeApp() {
  const app = new Hono();
  // Mirrors ./index.ts: the router registers '/running', '/start', '/stop' and
  // '/log' and is mounted under '/time', keeping the external paths unchanged.
  app.route('/time', officeAddinTimeRoutes);
  return app;
}

const EXPECTED_ACTOR = {
  userId: USER_ID,
  name: 'Tech Person',
  email: 'tech@partner.example',
  partnerId: PARTNER_ID,
  manageAll: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  authRef.current = { accessibleOrgIds: null };
});

describe('GET /time/running', () => {
  it('returns the running timer for the calling technician, mapped to the addin shape', async () => {
    hoisted.getRunningTimer.mockResolvedValue({
      id: ENTRY_ID,
      ticketId: TICKET_ID,
      ticketNumber: 'TKT-100',
      startedAt: new Date('2026-08-15T10:00:00Z'),
      description: 'debugging',
    });

    const res = await makeApp().request('/time/running');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.running).toEqual({
      id: ENTRY_ID,
      ticketId: TICKET_ID,
      ticketInternalNumber: 'TKT-100',
      startedAt: '2026-08-15T10:00:00.000Z',
      description: 'debugging',
    });
    expect(hoisted.getRunningTimer).toHaveBeenCalledWith(USER_ID);
  });

  it('returns null when no timer is running (own timer only — never another user\'s)', async () => {
    hoisted.getRunningTimer.mockResolvedValue(null);

    const res = await makeApp().request('/time/running');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.running).toBeNull();
    expect(hoisted.getRunningTimer).toHaveBeenCalledWith(USER_ID);
    expect(hoisted.getRunningTimer).not.toHaveBeenCalledWith(expect.not.stringMatching(USER_ID));
  });
});

describe('POST /time/start', () => {
  it('delegates to startTimer with the narrow tech actor (manageAll always false)', async () => {
    hoisted.getRunningTimer.mockResolvedValue(null);
    hoisted.startTimer.mockResolvedValue({ id: ENTRY_ID, ticketId: TICKET_ID, startedAt: new Date(), endedAt: null });

    const res = await makeApp().request('/time/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticketId: TICKET_ID, description: 'on it' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.entry.id).toBe(ENTRY_ID);
    expect(body.autoStopped).toBeNull();

    expect(hoisted.startTimer).toHaveBeenCalledWith(
      { ticketId: TICKET_ID, description: 'on it' },
      expect.objectContaining({ ...EXPECTED_ACTOR, accessibleOrgIds: null })
    );
  });

  it('includes the entry that startTimer auto-stopped, when one was running', async () => {
    const priorStartedAt = new Date('2026-08-15T09:00:00Z');
    hoisted.getRunningTimer.mockResolvedValue({
      id: PRIOR_ENTRY_ID,
      ticketId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      ticketNumber: 'TKT-99',
      startedAt: priorStartedAt,
      description: 'old task',
    });
    hoisted.startTimer.mockResolvedValue({ id: ENTRY_ID, ticketId: TICKET_ID, startedAt: new Date(), endedAt: null });

    const res = await makeApp().request('/time/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticketId: TICKET_ID }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.autoStopped).toEqual({
      id: PRIOR_ENTRY_ID,
      ticketId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      ticketInternalNumber: 'TKT-99',
      startedAt: priorStartedAt.toISOString(),
      description: 'old task',
    });
  });

  it('400s when ticketId is missing (required on this narrow surface)', async () => {
    const res = await makeApp().request('/time/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'no ticket' }),
    });
    expect(res.status).toBe(400);
    expect(hoisted.startTimer).not.toHaveBeenCalled();
  });

  it('maps TICKET_ORG_DENIED from resolveTicketLink to a 404', async () => {
    hoisted.getRunningTimer.mockResolvedValue(null);
    hoisted.startTimer.mockRejectedValue(new TimeEntryServiceError('Ticket not found', 404, 'TICKET_ORG_DENIED'));

    const res = await makeApp().request('/time/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticketId: TICKET_ID }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('TICKET_ORG_DENIED');
  });
});

describe('POST /time/stop', () => {
  it('delegates to stopTimer with the tech actor', async () => {
    hoisted.stopTimer.mockResolvedValue({ id: ENTRY_ID, endedAt: new Date() });

    const res = await makeApp().request('/time/stop', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'done', isBillable: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entry.id).toBe(ENTRY_ID);
    expect(hoisted.stopTimer).toHaveBeenCalledWith(
      { description: 'done', isBillable: true },
      expect.objectContaining(EXPECTED_ACTOR)
    );
  });

  it('passes through a 404 NO_RUNNING_TIMER from the service', async () => {
    hoisted.stopTimer.mockRejectedValue(new TimeEntryServiceError('No running timer', 404, 'NO_RUNNING_TIMER'));

    const res = await makeApp().request('/time/stop', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('NO_RUNNING_TIMER');
  });
});

describe('POST /time/log', () => {
  it('delegates to createTimeEntry with the tech actor', async () => {
    hoisted.createTimeEntry.mockResolvedValue({ id: ENTRY_ID, ticketId: TICKET_ID });

    const input = {
      ticketId: TICKET_ID,
      startedAt: '2026-08-15T09:00:00Z',
      endedAt: '2026-08-15T10:00:00Z',
      description: 'worked on it',
      isBillable: true,
    };
    const res = await makeApp().request('/time/log', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.entry.id).toBe(ENTRY_ID);

    expect(hoisted.createTimeEntry).toHaveBeenCalledTimes(1);
    const [actualInput, actualActor] = hoisted.createTimeEntry.mock.calls[0]!;
    expect(actualInput).toMatchObject({ ticketId: TICKET_ID, description: 'worked on it', isBillable: true });
    expect(actualInput.startedAt).toBeInstanceOf(Date);
    expect(actualInput.endedAt).toBeInstanceOf(Date);
    expect(actualActor).toMatchObject(EXPECTED_ACTOR);
  });

  it('400s when description is missing (required on this narrow surface)', async () => {
    const res = await makeApp().request('/time/log', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ticketId: TICKET_ID,
        startedAt: '2026-08-15T09:00:00Z',
        endedAt: '2026-08-15T10:00:00Z',
      }),
    });
    expect(res.status).toBe(400);
    expect(hoisted.createTimeEntry).not.toHaveBeenCalled();
  });

  it('maps a generic TimeEntryServiceError status/code through to JSON', async () => {
    hoisted.createTimeEntry.mockRejectedValue(
      new TimeEntryServiceError('Ticket must belong to the same partner', 400, 'TICKET_WRONG_PARTNER')
    );

    const res = await makeApp().request('/time/log', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ticketId: TICKET_ID,
        startedAt: '2026-08-15T09:00:00Z',
        endedAt: '2026-08-15T10:00:00Z',
        description: 'x',
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('TICKET_WRONG_PARTNER');
  });
});

describe('router surface', () => {
  it('has no other timeEntry routes (no bulk-approve, timesheet, update, delete)', async () => {
    const app = makeApp();

    const putRes = await app.request(`/time/${ENTRY_ID}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(putRes.status).toBe(404);

    const deleteRes = await app.request(`/time/${ENTRY_ID}`, { method: 'DELETE' });
    expect(deleteRes.status).toBe(404);

    const bulkApproveRes = await app.request('/time/bulk-approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [ENTRY_ID], approve: true }),
    });
    expect(bulkApproveRes.status).toBe(404);

    const timesheetRes = await app.request('/time/timesheet');
    expect(timesheetRes.status).toBe(404);

    const patchRes = await app.request(`/time/${ENTRY_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'x' }),
    });
    expect(patchRes.status).toBe(404);

    const listRes = await app.request('/time');
    expect(listRes.status).toBe(404);
  });
});
