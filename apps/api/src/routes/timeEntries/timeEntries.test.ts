import { describe, it, expect, vi, beforeEach } from 'vitest';

const { serviceMocks, authRef, permsRef } = vi.hoisted(() => ({
  serviceMocks: {
    createTimeEntry: vi.fn(),
    startTimer: vi.fn(),
    stopTimer: vi.fn(),
    updateTimeEntry: vi.fn(),
    deleteTimeEntry: vi.fn(),
    approveTimeEntries: vi.fn(),
    listTimeEntries: vi.fn(),
    getRunningTimer: vi.fn(),
    getTimesheet: vi.fn()
  },
  authRef: {
    current: {
      scope: 'partner' as string,
      user: { id: '1f2f1d8e-0001-4000-8000-000000000001', name: 'Tess Tech', email: 'tess@msp.example', isPlatformAdmin: false },
      partnerId: 'p-1' as string | null,
      orgId: null as string | null,
      accessibleOrgIds: null as string[] | null,
      orgCondition: () => undefined,
      canAccessOrg: (_id: string) => true as boolean
    }
  },
  // wildcard permission present => manageAll admin
  permsRef: { current: { permissions: [{ resource: 'time_entries', action: 'write' }, { resource: 'time_entries', action: 'read' }] } }
}));

vi.mock('../../services/timeEntryService', async () => {
  const actual = await vi.importActual<typeof import('../../services/timeEntryService')>('../../services/timeEntryService');
  return { ...actual, ...serviceMocks };
});

vi.mock('../../middleware/auth', async () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => {
    if (!authRef.current) return c.json({ error: 'Not authenticated' }, 401);
    c.set('auth', authRef.current);
    await next();
  }),
  requireScope: (...scopes: string[]) => async (c: any, next: any) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Not authenticated' }, 401);
    if (!scopes.includes(auth.scope)) return c.json({ error: 'Forbidden' }, 403);
    await next();
  },
  requirePermission: () => async (c: any, next: any) => {
    c.set('permissions', permsRef.current);
    await next();
  }
}));

import { timeEntriesRoutes } from './index';

const ADMIN_PERMS = { permissions: [{ resource: '*', action: '*' }] };
const TIME_ENTRY_ID = '3f2f1d8e-1111-4222-8333-444455556666';

beforeEach(() => {
  Object.values(serviceMocks).forEach((m) => m.mockReset());
  authRef.current.scope = 'partner';
  permsRef.current = { permissions: [{ resource: 'time_entries', action: 'write' }, { resource: 'time_entries', action: 'read' }] };
});

describe('GET /time-entries', () => {
  it('403s org-scope callers (internal-only, spec D4)', async () => {
    authRef.current.scope = 'organization';
    const res = await timeEntriesRoutes.request('/');
    expect(res.status).toBe(403);
  });

  it('forces userId=self for non-admin callers (D5)', async () => {
    serviceMocks.listTimeEntries.mockResolvedValue({ entries: [], total: 0 });
    const res = await timeEntriesRoutes.request('/?userId=1f2f1d8e-0001-4000-8000-000000000002');
    expect(res.status).toBe(200);
    expect(serviceMocks.listTimeEntries).toHaveBeenCalledWith(expect.objectContaining({ userId: '1f2f1d8e-0001-4000-8000-000000000001' }));
  });

  it('lets wildcard-permission admins query any user', async () => {
    permsRef.current = ADMIN_PERMS;
    serviceMocks.listTimeEntries.mockResolvedValue({ entries: [], total: 0 });
    const res = await timeEntriesRoutes.request('/?userId=1f2f1d8e-0001-4000-8000-000000000002');
    expect(res.status).toBe(200);
    expect(serviceMocks.listTimeEntries).toHaveBeenCalledWith(expect.objectContaining({ userId: '1f2f1d8e-0001-4000-8000-000000000002' }));
  });

  it('403s when caller supplies a foreign orgId not in their accessible set (#sec-review-1)', async () => {
    // canAccessOrg returns false for this org — simulates orgAccess='selected' partner user
    authRef.current.canAccessOrg = (_id: string) => false;
    const res = await timeEntriesRoutes.request('/?orgId=1f2f1d8e-ffff-4000-8000-000000000099');
    expect(res.status).toBe(403);
    expect(serviceMocks.listTimeEntries).not.toHaveBeenCalled();
    // restore
    authRef.current.canAccessOrg = (_id: string) => true;
  });

  it('passes orgId through and calls the service when org is accessible', async () => {
    // canAccessOrg returns true (default) — caller has access to this org
    const GRANTED_ORG = '1f2f1d8e-aaaa-4000-8000-000000000010';
    serviceMocks.listTimeEntries.mockResolvedValue({ entries: [], total: 0 });
    const res = await timeEntriesRoutes.request(`/?orgId=${GRANTED_ORG}`);
    expect(res.status).toBe(200);
    expect(serviceMocks.listTimeEntries).toHaveBeenCalledWith(expect.objectContaining({ orgId: GRANTED_ORG }));
  });
});

describe('timer endpoints', () => {
  it('POST /start passes manageAll=false actor and returns the entry', async () => {
    serviceMocks.startTimer.mockResolvedValue({ id: 'te-1', endedAt: null });
    const res = await timeEntriesRoutes.request('/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticketId: '3f2f1d8e-1111-4222-8333-444455556666' })
    });
    expect(res.status).toBe(201);
    expect(serviceMocks.startTimer).toHaveBeenCalledWith(
      expect.objectContaining({ ticketId: '3f2f1d8e-1111-4222-8333-444455556666' }),
      expect.objectContaining({ userId: '1f2f1d8e-0001-4000-8000-000000000001', partnerId: 'p-1', manageAll: false })
    );
  });

  it('maps TimeEntryServiceError to its status', async () => {
    const { TimeEntryServiceError } = await vi.importActual<typeof import('../../services/timeEntryService')>('../../services/timeEntryService');
    serviceMocks.stopTimer.mockRejectedValue(new TimeEntryServiceError('No running timer', 404, 'NO_RUNNING_TIMER'));
    const res = await timeEntriesRoutes.request('/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'No running timer', code: 'NO_RUNNING_TIMER' });
  });

  it('GET /running returns null data when nothing is running', async () => {
    serviceMocks.getRunningTimer.mockResolvedValue(null);
    const res = await timeEntriesRoutes.request('/running');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: null });
  });
});

describe('POST /bulk-approve', () => {
  it('surfaces skippedReasons from the service', async () => {
    permsRef.current = ADMIN_PERMS;
    serviceMocks.approveTimeEntries.mockResolvedValue({ updated: 1, skipped: 1, skippedReasons: { ENTRY_RUNNING: 1 } });
    const res = await timeEntriesRoutes.request('/bulk-approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ['3f2f1d8e-1111-4222-8333-444455556666'] })
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { updated: 1, skippedReasons: { ENTRY_RUNNING: 1 } } });
  });
});

describe('PATCH /:id and DELETE /:id', () => {
  it('PATCH /:id passes the parsed update body and actor to the service', async () => {
    serviceMocks.updateTimeEntry.mockResolvedValue({ id: TIME_ENTRY_ID, description: 'fixed' });
    const res = await timeEntriesRoutes.request(`/${TIME_ENTRY_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'fixed', endedAt: '2026-06-11T10:00:00Z' })
    });
    expect(res.status).toBe(200);
    expect(serviceMocks.updateTimeEntry).toHaveBeenCalledWith(
      TIME_ENTRY_ID,
      expect.objectContaining({ description: 'fixed', endedAt: expect.any(Date) }),
      expect.objectContaining({ userId: '1f2f1d8e-0001-4000-8000-000000000001', partnerId: 'p-1', manageAll: false })
    );
    await expect(res.json()).resolves.toEqual({ data: { id: TIME_ENTRY_ID, description: 'fixed' } });
  });

  it('PATCH /:id maps TimeEntryServiceError to its status', async () => {
    const { TimeEntryServiceError } = await vi.importActual<typeof import('../../services/timeEntryService')>('../../services/timeEntryService');
    serviceMocks.updateTimeEntry.mockRejectedValue(new TimeEntryServiceError('Approved entries can only be changed by an approver', 403, 'APPROVED_IMMUTABLE'));
    const res = await timeEntriesRoutes.request(`/${TIME_ENTRY_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'fixed' })
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'APPROVED_IMMUTABLE' });
  });

  it('DELETE /:id deletes through the service and returns deleted true', async () => {
    serviceMocks.deleteTimeEntry.mockResolvedValue(undefined);
    const res = await timeEntriesRoutes.request(`/${TIME_ENTRY_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(serviceMocks.deleteTimeEntry).toHaveBeenCalledWith(
      TIME_ENTRY_ID,
      expect.objectContaining({ userId: '1f2f1d8e-0001-4000-8000-000000000001', partnerId: 'p-1', manageAll: false })
    );
    expect(await res.json()).toEqual({ data: { deleted: true } });
  });

  it('DELETE /:id maps service not-found to 404', async () => {
    const { TimeEntryServiceError } = await vi.importActual<typeof import('../../services/timeEntryService')>('../../services/timeEntryService');
    serviceMocks.deleteTimeEntry.mockRejectedValue(new TimeEntryServiceError('Time entry not found', 404, 'ENTRY_NOT_FOUND'));
    const res = await timeEntriesRoutes.request(`/${TIME_ENTRY_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'ENTRY_NOT_FOUND' });
  });
});

describe('GET /timesheet', () => {
  it("403s a non-admin requesting someone else's timesheet", async () => {
    const res = await timeEntriesRoutes.request('/timesheet?userId=1f2f1d8e-0001-4000-8000-000000000002&weekStart=2026-06-08');
    expect(res.status).toBe(403);
  });

  it('defaults to own timesheet and passes null accessibleOrgIds', async () => {
    serviceMocks.getTimesheet.mockResolvedValue({ weekStart: '2026-06-08', days: [], totals: { totalMinutes: 0, billableMinutes: 0 } });
    const res = await timeEntriesRoutes.request('/timesheet?weekStart=2026-06-08');
    expect(res.status).toBe(200);
    expect(serviceMocks.getTimesheet).toHaveBeenCalledWith('1f2f1d8e-0001-4000-8000-000000000001', expect.any(Date), null);
  });

  it('threads accessibleOrgIds to getTimesheet for org-axis narrowing (#sec-review-1)', async () => {
    // Simulate orgAccess='selected': only two granted orgs
    const grantedOrgs = ['1f2f1d8e-aaaa-4000-8000-000000000010', '1f2f1d8e-bbbb-4000-8000-000000000011'];
    authRef.current.accessibleOrgIds = grantedOrgs;
    serviceMocks.getTimesheet.mockResolvedValue({ weekStart: '2026-06-08', days: [], totals: { totalMinutes: 0, billableMinutes: 0 } });
    const res = await timeEntriesRoutes.request('/timesheet?weekStart=2026-06-08');
    expect(res.status).toBe(200);
    // Third argument must be the org allowlist so the service can apply orgAxisSql
    expect(serviceMocks.getTimesheet).toHaveBeenCalledWith(
      '1f2f1d8e-0001-4000-8000-000000000001',
      expect.any(Date),
      grantedOrgs
    );
    // restore
    authRef.current.accessibleOrgIds = null;
  });
});
