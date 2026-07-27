import { describe, it, expect, vi, beforeEach } from 'vitest';

const { serviceMocks, authRef, permsRef, auditMock } = vi.hoisted(() => ({
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
  permsRef: { current: { permissions: [{ resource: 'time_entries', action: 'write' }, { resource: 'time_entries', action: 'read' }] } },
  auditMock: vi.fn(),
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

vi.mock('../../services/auditEvents', () => ({
  writeRouteAudit: auditMock,
}));

import { timeEntriesRoutes } from './index';

const ADMIN_PERMS = { permissions: [{ resource: '*', action: '*' }] };
const TIME_ENTRY_ID = '3f2f1d8e-1111-4222-8333-444455556666';

beforeEach(() => {
  Object.values(serviceMocks).forEach((m) => m.mockReset());
  auditMock.mockReset();
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

describe('explicit time-entry mutation audits', () => {
  const ORG_A = '1f2f1d8e-aaaa-4000-8000-000000000010';
  const ORG_B = '1f2f1d8e-bbbb-4000-8000-000000000011';
  const ENTRY_A = '3f2f1d8e-aaaa-4222-8333-444455556661';
  const ENTRY_B = '3f2f1d8e-bbbb-4222-8333-444455556662';

  it.each([
    {
      label: 'create',
      service: serviceMocks.createTimeEntry,
      path: '/',
      method: 'POST',
      body: {
        startedAt: '2026-06-11T09:00:00Z',
        endedAt: '2026-06-11T09:30:00Z',
      },
      action: 'time_entry.created',
      status: 201,
    },
    {
      label: 'stop',
      service: serviceMocks.stopTimer,
      path: '/stop',
      method: 'POST',
      body: {},
      action: 'time_entry.stopped',
      status: 200,
    },
    {
      label: 'update',
      service: serviceMocks.updateTimeEntry,
      path: `/${ENTRY_A}`,
      method: 'PATCH',
      body: { description: 'updated' },
      action: 'time_entry.updated',
      status: 200,
    },
    {
      label: 'delete',
      service: serviceMocks.deleteTimeEntry,
      path: `/${ENTRY_A}`,
      method: 'DELETE',
      body: undefined,
      action: 'time_entry.deleted',
      status: 200,
    },
  ])('writes one exact explicit audit for $label', async ({
    service,
    path,
    method,
    body,
    action,
    status,
  }) => {
    service.mockImplementation(async (...args: unknown[]) => {
      const actor = args.at(-1) as {
        recordAuditMutation?: (mutation: unknown) => void;
      };
      actor.recordAuditMutation?.({
        action,
        entryId: ENTRY_A,
        orgId: ORG_A,
      });
      return method === 'DELETE' ? undefined : { id: ENTRY_A, orgId: ORG_A };
    });

    const res = await timeEntriesRoutes.request(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });

    expect(res.status).toBe(status);
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock).toHaveBeenCalledWith(expect.anything(), {
      orgId: ORG_A,
      action,
      resourceType: 'time_entry',
      resourceId: ENTRY_A,
      details: { entryIds: [ENTRY_A], count: 1 },
    });
  });

  it('emits one audit per affected entry for start auto-stop ownership', async () => {
    serviceMocks.startTimer.mockImplementation(async (_input, actor) => {
      actor.recordAuditMutation?.({
        action: 'time_entry.stopped',
        entryId: ENTRY_A,
        orgId: ORG_A,
      });
      actor.recordAuditMutation?.({
        action: 'time_entry.started',
        entryId: ENTRY_B,
        orgId: ORG_B,
      });
      return { id: ENTRY_B, orgId: ORG_B };
    });

    const res = await timeEntriesRoutes.request('/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'next task' }),
    });

    expect(res.status).toBe(201);
    expect(auditMock.mock.calls.map(([, event]) => event)).toEqual([
      {
        orgId: ORG_A,
        action: 'time_entry.stopped',
        resourceType: 'time_entry',
        resourceId: ENTRY_A,
        details: { entryIds: [ENTRY_A], count: 1 },
      },
      {
        orgId: ORG_B,
        action: 'time_entry.started',
        resourceType: 'time_entry',
        resourceId: ENTRY_B,
        details: { entryIds: [ENTRY_B], count: 1 },
      },
    ]);
  });

  it('groups bulk audit records by exact org, preserving NULL org ownership', async () => {
    permsRef.current = ADMIN_PERMS;
    serviceMocks.approveTimeEntries.mockImplementation(async (_ids, _approve, actor) => {
      actor.recordAuditMutation?.({
        action: 'time_entry.approved',
        entryId: ENTRY_A,
        orgId: ORG_A,
      });
      actor.recordAuditMutation?.({
        action: 'time_entry.approved',
        entryId: ENTRY_B,
        orgId: ORG_A,
      });
      actor.recordAuditMutation?.({
        action: 'time_entry.approved',
        entryId: TIME_ENTRY_ID,
        orgId: null,
      });
      return { updated: 3, skipped: 1, skippedReasons: { ENTRY_NOT_FOUND: 1 } };
    });

    const res = await timeEntriesRoutes.request('/bulk-approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ids: [ENTRY_A, ENTRY_B, TIME_ENTRY_ID, '3f2f1d8e-cccc-4222-8333-444455556663'],
        approve: true,
      }),
    });

    expect(res.status).toBe(200);
    expect(auditMock.mock.calls.map(([, event]) => event)).toEqual([
      {
        orgId: ORG_A,
        action: 'time_entry.approved',
        resourceType: 'time_entry',
        details: { entryIds: [ENTRY_A, ENTRY_B], count: 2 },
      },
      {
        orgId: null,
        action: 'time_entry.approved',
        resourceType: 'time_entry',
        details: { entryIds: [TIME_ENTRY_ID], count: 1 },
      },
    ]);
  });

  it('does not audit a failed service operation', async () => {
    const { TimeEntryServiceError } = await vi.importActual<
      typeof import('../../services/timeEntryService')
    >('../../services/timeEntryService');
    serviceMocks.updateTimeEntry.mockRejectedValue(
      new TimeEntryServiceError('Time entry not found', 404, 'ENTRY_NOT_FOUND'),
    );

    const res = await timeEntriesRoutes.request(`/${ENTRY_A}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'denied' }),
    });

    expect(res.status).toBe(404);
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('keeps a successful response when explicit audit delivery throws', async () => {
    serviceMocks.createTimeEntry.mockImplementation(async (_input, actor) => {
      actor.recordAuditMutation?.({
        action: 'time_entry.created',
        entryId: ENTRY_A,
        orgId: ORG_A,
      });
      return { id: ENTRY_A, orgId: ORG_A };
    });
    auditMock.mockImplementation(() => {
      throw new Error('audit backend unavailable');
    });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const res = await timeEntriesRoutes.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          startedAt: '2026-06-11T09:00:00Z',
          endedAt: '2026-06-11T09:30:00Z',
        }),
      });

      expect(res.status).toBe(201);
      await expect(res.json()).resolves.toEqual({
        data: { id: ENTRY_A, orgId: ORG_A },
      });
    } finally {
      consoleSpy.mockRestore();
    }
  });
});
