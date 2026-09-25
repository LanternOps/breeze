import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const PARTNER_ID = '11111111-1111-4111-8111-111111111111';
const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_ID = '99999999-9999-4999-8999-999999999999';
const TICKET_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ENTRY_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const PRIOR_ENTRY_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

type AuthState = {
  accessibleOrgIds: string[] | null;
  manageBilling?: boolean;
  billingProfilesRead?: boolean;
  deniedCapabilities?: string[];
};

const { authRef, hoisted } = vi.hoisted(() => ({
  authRef: { current: { accessibleOrgIds: null as string[] | null } as AuthState },
  hoisted: {
    getRunningTimer: vi.fn(),
    startTimer: vi.fn(),
    stopTimer: vi.fn(),
    createTimeEntry: vi.fn(),
    listWorkTypes: vi.fn(),
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
      permissions: {
        permissions: [
          ...(authRef.current.manageBilling ? [{ resource: 'time_entries', action: 'manage_billing' }] : []),
          ...(authRef.current.billingProfilesRead ? [{ resource: 'billing_profiles', action: 'read' }] : []),
        ],
      },
      canAccessOrg: (orgId: string) => accessibleOrgIds === null || accessibleOrgIds.includes(orgId),
      canAccessSite: () => true,
    });
    return next();
  }),
  // Honours `deniedCapabilities` so a test can prove WHICH capability a route
  // is registered behind, not merely that some middleware ran.
  requireAddinCapability: vi.fn((cap: string) => async (c: any, next: any) =>
    authRef.current.deniedCapabilities?.includes(cap) ? c.json({ error: 'Forbidden' }, 403) : next()),
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

vi.mock('../../services/workTypeService', () => ({
  listWorkTypes: hoisted.listWorkTypes,
}));

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

  it('400s with a clear "required" message (not a coercion error) when startedAt/endedAt are missing', async () => {
    const res = await makeApp().request('/time/log', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticketId: TICKET_ID, description: 'x' }),
    });
    expect(res.status).toBe(400);
    expect(hoisted.createTimeEntry).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.error).not.toMatch(/received Date/i);
    expect(body.error).toMatch(/startedAt is required/i);
    expect(body.error).toMatch(/endedAt is required/i);
  });

  // A `null`/`false`/`0` sentinel must be rejected the same as a missing
  // field, not silently coerced by `new Date(null|false|0)` into a "valid"
  // 1970-01-01 epoch date (review finding on #6497 G2-4).
  it('400s on a null/false/0 startedAt instead of silently coercing to epoch', async () => {
    for (const bad of [null, false, 0]) {
      const res = await makeApp().request('/time/log', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ticketId: TICKET_ID, description: 'x', startedAt: bad, endedAt: '2026-08-15T10:00:00Z' }),
      });
      expect(res.status, `startedAt=${JSON.stringify(bad)} must 400`).toBe(400);
      expect(hoisted.createTimeEntry).not.toHaveBeenCalled();
      const body = await res.json();
      expect(body.error).not.toMatch(/received Date/i);
    }
  });

  it('400s with a clear "must be a valid date" message for a garbage-but-present startedAt', async () => {
    const res = await makeApp().request('/time/log', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticketId: TICKET_ID, description: 'x', startedAt: 'not-a-date', endedAt: '2026-08-15T10:00:00Z' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/startedAt must be a valid date/i);
    expect(body.error).not.toMatch(/received Date/i);
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


describe('billing override actor plumbing', () => {
  it.each([false, true])('refuses add-in billing overrides even with manage_billing=%s and strips forged rates', async manageBilling => {
    authRef.current.manageBilling = manageBilling;
    hoisted.createTimeEntry.mockResolvedValue({ id: ENTRY_ID, ticketId: TICKET_ID });
    const res = await makeApp().request('/time/log', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticketId: TICKET_ID, startedAt: '2026-06-11T09:00:00Z',
        endedAt: '2026-06-11T09:30:00Z', description: 'Repair', hourlyRate: 999 }),
    });
    expect(res.status).toBe(201);
    expect(hoisted.createTimeEntry.mock.calls[0]?.[0]).not.toHaveProperty('hourlyRate');
    expect(hoisted.createTimeEntry.mock.calls[0]?.[1]).toMatchObject({ manageBilling: false, manageAll: false });
  });
});

describe('work type on add-in time writes (#4628 W04)', () => {
  const WORK_TYPE_ID = '44444444-4444-4444-8444-444444444444';
  const LOG_BASE = {
    ticketId: TICKET_ID,
    startedAt: '2026-06-11T09:00:00Z',
    endedAt: '2026-06-11T09:30:00Z',
    description: 'On-site fix',
  };
  const post = (path: string, body: unknown) =>
    makeApp().request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('POST /time/log passes workTypeId through to createTimeEntry', async () => {
    hoisted.createTimeEntry.mockResolvedValue({ id: ENTRY_ID, ticketId: TICKET_ID });
    const res = await post('/time/log', { ...LOG_BASE, workTypeId: WORK_TYPE_ID });
    expect(res.status).toBe(201);
    expect(hoisted.createTimeEntry.mock.calls[0]?.[0]).toMatchObject({ workTypeId: WORK_TYPE_ID });
  });

  it('omitting workTypeId leaves the field OFF the service input, so the category default applies (§3.1)', async () => {
    hoisted.createTimeEntry.mockResolvedValue({ id: ENTRY_ID, ticketId: TICKET_ID });
    await post('/time/log', LOG_BASE);
    expect(hoisted.createTimeEntry.mock.calls[0]?.[0]).not.toHaveProperty('workTypeId');
  });

  it('a non-uuid workTypeId is a 400, not a silently dropped field', async () => {
    const res = await post('/time/log', { ...LOG_BASE, workTypeId: 'Remote' });
    expect(res.status).toBe(400);
    expect(hoisted.createTimeEntry).not.toHaveBeenCalled();
  });

  it('a null workTypeId is a 400: the add-in offers a work type or the default, never "none"', async () => {
    const res = await post('/time/log', { ...LOG_BASE, workTypeId: null });
    expect(res.status).toBe(400);
  });

  it('POST /time/start passes workTypeId through; timers are priced at START (section 3.7)', async () => {
    hoisted.getRunningTimer.mockResolvedValue(null);
    hoisted.startTimer.mockResolvedValue({ id: ENTRY_ID, ticketId: TICKET_ID });
    const res = await post('/time/start', { ticketId: TICKET_ID, workTypeId: WORK_TYPE_ID });
    expect(res.status).toBe(201);
    expect(hoisted.startTimer.mock.calls[0]?.[0]).toMatchObject({ workTypeId: WORK_TYPE_ID });
    expect(hoisted.startTimer.mock.calls[0]?.[1]).toMatchObject({ manageBilling: false, manageAll: false });
  });

  it('POST /time/start without a workTypeId leaves it off the service input', async () => {
    hoisted.getRunningTimer.mockResolvedValue(null);
    hoisted.startTimer.mockResolvedValue({ id: ENTRY_ID, ticketId: TICKET_ID });
    await post('/time/start', { ticketId: TICKET_ID });
    expect(hoisted.startTimer.mock.calls[0]?.[0]).not.toHaveProperty('workTypeId');
  });
});

describe('GET /time/work-types (#4628 W04)', () => {
  it("returns the partner's active work types as id + name only", async () => {
    authRef.current.billingProfilesRead = true;
    hoisted.listWorkTypes.mockResolvedValue([
      { id: 'wt-1', name: 'Remote', isActive: true, sortOrder: 1, partnerId: PARTNER_ID },
    ]);
    const res = await makeApp().request('/time/work-types');
    expect(res.status).toBe(200);
    // Narrow projection on purpose: the add-in needs a label, not the card.
    expect(await res.json()).toEqual({ workTypes: [{ id: 'wt-1', name: 'Remote' }] });
    // The principal's own partner, active only; never a caller-supplied partner.
    expect(hoisted.listWorkTypes).toHaveBeenCalledWith(PARTNER_ID);
  });

  it('is registered behind the time-read capability', async () => {
    authRef.current.billingProfilesRead = true;
    authRef.current.deniedCapabilities = ['time-read'];
    const res = await makeApp().request('/time/work-types');
    expect(res.status).toBe(403);
    expect(hoisted.listWorkTypes).not.toHaveBeenCalled();
  });

  it('403s a technician without billing_profiles:read, the same gate as the web picker', async () => {
    const res = await makeApp().request('/time/work-types');
    expect(res.status).toBe(403);
    expect(hoisted.listWorkTypes).not.toHaveBeenCalled();
  });
});
