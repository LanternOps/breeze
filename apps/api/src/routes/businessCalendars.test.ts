import { beforeEach, describe, expect, it, vi } from 'vitest';

const { serviceMocks, applyMocks, authRef, permCalls, writeRouteAuditMock } = vi.hoisted(() => ({
  serviceMocks: {
    listCalendars: vi.fn(),
    getCalendar: vi.fn(),
    getResolvedCalendarForOrg: vi.fn(),
    createCalendar: vi.fn(),
    updateCalendar: vi.fn(),
    setPartnerDefault: vi.fn(),
    clearPartnerDefault: vi.fn(),
    archiveCalendar: vi.fn(),
    deleteCalendar: vi.fn(),
    addHoliday: vi.fn(),
    removeHoliday: vi.fn(),
    setOrgCalendarOverride: vi.fn(),
  },
  applyMocks: { previewApplyRevision: vi.fn(), applyRevision: vi.fn() },
  authRef: {
    current: {
      scope: 'partner', partnerId: 'p-1', orgId: null, partnerOrgAccess: 'all', accessibleOrgIds: null,
      canAccessOrg: () => true, user: { id: 'u-1', email: 'u@example.com', name: 'U', isPlatformAdmin: false },
    } as Record<string, unknown> | null,
  },
  permCalls: [] as Array<[string, string]>,
  writeRouteAuditMock: vi.fn(),
}));

vi.mock('../services/businessCalendars/service', async () => {
  const actual = await vi.importActual<typeof import('../services/businessCalendars/service')>('../services/businessCalendars/service');
  return { ...actual, ...serviceMocks };
});
vi.mock('../services/businessCalendars/applyRevision', () => applyMocks);
vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => {
    if (!authRef.current) return c.json({ error: 'Not authenticated' }, 401);
    c.set('auth', authRef.current);
    await next();
  }),
  requireScope: (...scopes: string[]) => async (c: any, next: any) => {
    if (!scopes.includes(c.get('auth').scope)) return c.json({ error: 'Forbidden' }, 403);
    await next();
  },
  requirePermission: (resource: string, action: string) => async (_c: any, next: any) => {
    permCalls.push([resource, action]);
    await next();
  },
}));
vi.mock('../services/auditEvents', () => ({ writeRouteAudit: writeRouteAuditMock }));

import { businessCalendarRoutes } from './businessCalendars';
import { BusinessCalendarError } from '../services/businessCalendars/service';
import { PartnerWideWriteDeniedError } from '../services/partnerWideAccess';

const CAL = '11111111-1111-4111-8111-111111111111';
const ORG = '22222222-2222-4222-8222-222222222222';
const HOL = '33333333-3333-4333-8333-333333333333';
const REV = '44444444-4444-4444-8444-444444444444';
const weekdays = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 540, endMinute: 1020 }));
const dto = { id: CAL, name: 'Support', ownerScope: 'partner', orgId: null, partnerId: 'p-1' };

const req = (method: string, path: string, body?: unknown) =>
  businessCalendarRoutes.request(path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeEach(() => {
  Object.values(serviceMocks).forEach((m) => m.mockReset());
  Object.values(applyMocks).forEach((m) => m.mockReset());
  writeRouteAuditMock.mockReset();
  permCalls.length = 0;
  authRef.current = {
    scope: 'partner', partnerId: 'p-1', orgId: null, partnerOrgAccess: 'all', accessibleOrgIds: null,
    canAccessOrg: () => true, user: { id: 'u-1', email: 'u@example.com', name: 'U', isPlatformAdmin: false },
  };
});

const WRITE_CASES: Array<[string, string, unknown?]> = [
  ['POST', '/', { ownerScope: 'partner', name: 'Support', timezone: 'UTC', intervals: weekdays }],
  ['PATCH', `/${CAL}`, { name: 'Renamed' }],
  ['POST', `/${CAL}/default`],
  ['DELETE', '/default'],
  ['POST', `/${CAL}/archive`, { archived: true }],
  ['DELETE', `/${CAL}`],
  ['POST', `/${CAL}/holidays`, { date: '2030-12-25', name: 'Christmas' }],
  ['DELETE', `/${CAL}/holidays/${HOL}`],
  ['POST', `/${CAL}/apply-revision`, { expectedRevisionId: REV }],
  ['PUT', `/orgs/${ORG}/override`, { calendarId: CAL }],
];

describe('scope and permission gates', () => {
  it.each(WRITE_CASES)('an organization-scope token is refused %s %s (requireScope partner/system)', async (method, path, body) => {
    authRef.current = { ...authRef.current!, scope: 'organization', orgId: ORG };
    const res = await req(method, path, body);
    expect(res.status).toBe(403);
    for (const m of [...Object.values(serviceMocks), ...Object.values(applyMocks)]) expect(m).not.toHaveBeenCalled();
  });

  it.each(WRITE_CASES)('%s %s requires a write permission', async (method, path, body) => {
    await req(method, path, body);
    expect(permCalls.some(([, action]) => action === 'write')).toBe(true);
  });

  it('reads require tickets:read', async () => {
    serviceMocks.listCalendars.mockResolvedValue([]);
    await req('GET', '/');
    expect(permCalls).toContainEqual(['tickets', 'read']);
  });

  it('the org override is an org setting: organizations:write', async () => {
    await req('PUT', `/orgs/${ORG}/override`, { calendarId: null });
    expect(permCalls).toContainEqual(['organizations', 'write']);
  });
});

describe('CRUD', () => {
  it('GET / lists with the org filter', async () => {
    serviceMocks.listCalendars.mockResolvedValue([dto]);
    const res = await req('GET', `/?orgId=${ORG}&includeArchived=true`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [dto] });
    expect(serviceMocks.listCalendars).toHaveBeenCalledWith(expect.anything(), { orgId: ORG, includeArchived: true });
  });

  it('GET /resolved returns what a new ticket in the org would snapshot', async () => {
    serviceMocks.getResolvedCalendarForOrg.mockResolvedValue({ source: 'partner', calendarId: CAL, revisionId: REV, calendarName: 'Support', overrideCalendarId: null });
    const res = await req('GET', `/resolved?orgId=${ORG}`);
    expect(res.status).toBe(200);
    expect((await res.json()).data.source).toBe('partner');
  });

  it('POST / creates and audits; validation failures are 400 before the service', async () => {
    serviceMocks.createCalendar.mockResolvedValue(dto);
    const ok = await req('POST', '/', { ownerScope: 'partner', name: 'Support', timezone: 'UTC', intervals: weekdays });
    expect(ok.status).toBe(201);
    expect(writeRouteAuditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'business_calendar.create', resourceId: CAL }));

    const bad = await req('POST', '/', { ownerScope: 'partner', name: 'X', timezone: 'UTC', intervals: [
      { weekday: 1, startMinute: 0, endMinute: 600 }, { weekday: 1, startMinute: 300, endMinute: 900 },
    ] });
    expect(bad.status).toBe(400);
    expect(serviceMocks.createCalendar).toHaveBeenCalledTimes(1);
  });

  it('PATCH strips owner fields (the update schema omits them)', async () => {
    serviceMocks.updateCalendar.mockResolvedValue({ ...dto, revisionCreated: false });
    await req('PATCH', `/${CAL}`, { name: 'Renamed', ownerScope: 'organization', orgId: ORG });
    expect(serviceMocks.updateCalendar).toHaveBeenCalledWith(expect.anything(), CAL, { name: 'Renamed' });
  });

  it('holidays report whether a recompute was queued', async () => {
    serviceMocks.addHoliday.mockResolvedValue({
      holiday: { id: HOL, date: '2030-12-25', name: 'Christmas' }, recomputeQueued: true,
      calendar: { id: CAL, orgId: ORG, partnerId: null, name: 'Org hours' },
    });
    const res = await req('POST', `/${CAL}/holidays`, { date: '2030-12-25', name: 'Christmas' });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data).toEqual({ holiday: { id: HOL, date: '2030-12-25', name: 'Christmas' }, recomputeQueued: true });
    // An org-owned calendar's event is audited under its org, not the partner.
    expect(writeRouteAuditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'business_calendar.holiday.add', orgId: ORG, resourceId: CAL,
    }));
    expect(writeRouteAuditMock.mock.calls[0]![1]).not.toHaveProperty('partnerId');
  });

  it('GET apply-revision/preview returns the three counts; POST apply-revision passes the expected revision', async () => {
    applyMocks.previewApplyRevision.mockResolvedValue({ revisionId: REV, eligibleCount: 3, immediatelyBreachedCount: 1, skippedPausedCount: 2 });
    const preview = await req('GET', `/${CAL}/apply-revision/preview`);
    expect((await preview.json()).data).toEqual({ revisionId: REV, eligibleCount: 3, immediatelyBreachedCount: 1, skippedPausedCount: 2 });

    applyMocks.applyRevision.mockResolvedValue({ updated: 3, skippedLocked: 0 });
    const res = await req('POST', `/${CAL}/apply-revision`, { expectedRevisionId: REV });
    expect(res.status).toBe(200);
    expect(applyMocks.applyRevision).toHaveBeenCalledWith(expect.anything(), CAL, { expectedRevisionId: REV });
  });

  it('PUT /orgs/:orgId/override sets or clears the override', async () => {
    serviceMocks.setOrgCalendarOverride.mockResolvedValue(undefined);
    expect((await req('PUT', `/orgs/${ORG}/override`, { calendarId: CAL })).status).toBe(200);
    expect(serviceMocks.setOrgCalendarOverride).toHaveBeenCalledWith(expect.anything(), ORG, CAL);
  });
});

describe('error mapping', () => {
  it('BusinessCalendarError keeps its status and code', async () => {
    serviceMocks.deleteCalendar.mockRejectedValue(new BusinessCalendarError('Tickets use this calendar; archive it instead', 409, 'CALENDAR_IN_USE'));
    const res = await req('DELETE', `/${CAL}`);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'CALENDAR_IN_USE' });
  });

  it('REVISION_CHANGED is a 409', async () => {
    applyMocks.applyRevision.mockRejectedValue(new BusinessCalendarError('changed', 409, 'REVISION_CHANGED'));
    const res = await req('POST', `/${CAL}/apply-revision`, { expectedRevisionId: REV });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('REVISION_CHANGED');
  });

  it('PartnerWideWriteDeniedError is a 403', async () => {
    serviceMocks.setPartnerDefault.mockRejectedValue(new PartnerWideWriteDeniedError());
    const res = await req('POST', `/${CAL}/default`);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('ACCESS_DENIED');
  });
});
