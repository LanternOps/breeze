import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const TX = { marker: 'tx' };
const GROUP_KEY = 'a'.repeat(64);
const PLAN_FINGERPRINT = 'b'.repeat(64);
const R1 = '11111111-1111-4111-8111-111111111111';
const R2 = '22222222-2222-4222-8222-222222222222';

const state = vi.hoisted(() => ({
  auth: undefined as Record<string, unknown> | undefined,
  permissions: { permissions: [] as { resource: string; action: string }[] },
  mayAddRecipients: true,
  findCombineCandidates: vi.fn(),
  combineIntoSeries: vi.fn(),
  writeRouteAudit: vi.fn(),
}));

vi.mock('../../db', () => ({ db: { transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb(TX)) } }));
vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (c: any, next: () => Promise<void>) => {
    c.set('auth', state.auth);
    c.set('permissions', state.permissions);
    await next();
  },
  requireScope: (...scopes: string[]) => async (c: any, next: () => Promise<void>) =>
    scopes.includes(c.get('auth').scope) ? next() : c.json({ error: 'Insufficient scope' }, 403),
  requirePermission: (resource: string, action: string) => async (c: any, next: () => Promise<void>) =>
    state.permissions.permissions.some((p) => p.resource === resource && p.action === action)
      ? next()
      : c.json({ error: 'Permission denied' }, 403),
}));
vi.mock('../../services/permissions', () => ({
  PERMISSIONS: {
    REPORTS_READ: { resource: 'reports', action: 'read' },
    REPORTS_WRITE: { resource: 'reports', action: 'write' },
    REPORTS_EXPORT: { resource: 'reports', action: 'export' },
  },
}));
vi.mock('./recipientGate', () => ({
  RECIPIENTS_NEED_EXPORT_AND_MFA: {
    error: 'Setting or changing email recipients on a report requires the export permission and an MFA-verified session',
  },
  callerMaySetEmailRecipients: () => state.mayAddRecipients,
}));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: state.writeRouteAudit }));
vi.mock('../../services/reportSeries/combine', () => ({
  findCombineCandidates: state.findCombineCandidates,
  combineIntoSeries: state.combineIntoSeries,
}));

import { CombineError } from '../../services/reportSeries/combinePlan';
import { ReportSeriesError } from '../../services/reportSeries/errors';
import { PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../../services/partnerWideAccess';
import { RECIPIENTS_NEED_EXPORT_AND_MFA } from './recipientGate';
import { seriesCombineRoutes } from './seriesCombine';

const READ = { resource: 'reports', action: 'read' };
const WRITE = { resource: 'reports', action: 'write' };
const body = {
  groupKey: GROUP_KEY, planFingerprint: PLAN_FINGERPRINT, reportIds: [R1, R2], name: 'Weekly alerts', targetMode: 'selected',
  ccResolution: { include: [], drop: ['extra@msp.test'] },
};

function app() {
  const hono = new Hono();
  hono.route('/', seriesCombineRoutes);
  return hono;
}
const post = (payload: unknown) => app().request('/combine', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
});

describe('series Combine routes (W04)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.auth = { scope: 'partner', partnerId: 'partner-1', partnerOrgAccess: 'all', user: { id: 'user-1' }, token: { mfa: true } };
    state.permissions = { permissions: [READ, WRITE] };
    state.mayAddRecipients = true;
    state.findCombineCandidates.mockResolvedValue([{ groupKey: GROUP_KEY }]);
    state.combineIntoSeries.mockResolvedValue({
      seriesId: 'series-1',
      adopted: [{ reportId: R1, orgId: 'org-a' }, { reportId: R2, orgId: 'org-b' }],
      archived: [{ reportId: 'dup-1', orgId: 'org-a' }],
      repointedDeliverableIds: [],
    });
  });

  it("GET /combine-candidates lists the caller's own partner, in a transaction", async () => {
    const res = await app().request('/combine-candidates');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [{ groupKey: GROUP_KEY }] });
    expect(state.findCombineCandidates).toHaveBeenCalledWith('partner-1', TX);
  });

  it('refuses an organization-scope token on both routes', async () => {
    state.auth = { scope: 'organization', orgId: 'org-a', partnerId: 'partner-1', user: { id: 'u' }, token: { mfa: true } };
    expect((await app().request('/combine-candidates')).status).toBe(403);
    expect((await post(body)).status).toBe(403);
    expect(state.findCombineCandidates).not.toHaveBeenCalled();
    expect(state.combineIntoSeries).not.toHaveBeenCalled();
  });

  it("refuses a partner user whose org_access is 'selected'", async () => {
    state.auth = { ...state.auth, partnerOrgAccess: 'selected' };
    const res = await post(body);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE });
    expect((await app().request('/combine-candidates')).status).toBe(403);
    expect(state.combineIntoSeries).not.toHaveBeenCalled();
  });

  it('POST /combine needs reports:write', async () => {
    state.permissions = { permissions: [READ] };
    expect((await post(body)).status).toBe(403);
  });

  it("POST /combine passes W02's gate result (never a body flag) and audits partner + each org", async () => {
    const res = await post({ ...body, callerMaySetEmailRecipients: false }); // stripped by the schema
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ seriesId: 'series-1' });
    expect(state.combineIntoSeries).toHaveBeenCalledWith(
      { ...body, callerMaySetEmailRecipients: true },
      state.auth,
      TX,
    );
    const actions = state.writeRouteAudit.mock.calls.map(([, event]) => [event.action, event.orgId, event.resourceId]);
    expect(actions).toEqual([
      ['report_series.combine', null, 'series-1'],
      ['report.series_adopt', 'org-a', R1],
      ['report.series_adopt', 'org-b', R2],
      ['report.archive', 'org-a', 'dup-1'],
    ]);

    state.mayAddRecipients = false;
    await post(body);
    expect(state.combineIntoSeries.mock.calls[1]![0].callerMaySetEmailRecipients).toBe(false);
  });

  it('maps CombineError and W02 ReportSeriesError through seriesErrorResponse; the recipient gate keeps the core.ts body', async () => {
    const conflict = { error: 'combine_cc_conflict', shared: ['cc@msp.test'], unresolved: [{ email: 'x@msp.test', reportIds: [R1] }], unexpected: [] };
    state.combineIntoSeries.mockRejectedValueOnce(new CombineError('combine_cc_conflict', 409, conflict));
    let res = await post(body);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject(conflict);

    state.combineIntoSeries.mockRejectedValueOnce(new CombineError('recipients_need_export_and_mfa', 403, { error: 'recipients_need_export_and_mfa' }));
    res = await post(body);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(RECIPIENTS_NEED_EXPORT_AND_MFA);

    state.combineIntoSeries.mockRejectedValueOnce(new ReportSeriesError('series_owner_ineligible', 400));
    res = await post(body);
    expect(res.status).toBe(400);
    expect(state.writeRouteAudit).not.toHaveBeenCalled();
  });

  it('lets an unknown error reach the error handler (500), never a silent 200', async () => {
    state.combineIntoSeries.mockRejectedValueOnce(new Error('boom'));
    expect((await post(body)).status).toBe(500);
  });

  it('validates the body before touching the service', async () => {
    expect((await post({ ...body, reportIds: [R1] })).status).toBe(400);
    expect((await post({ ...body, groupKey: 'nope' })).status).toBe(400);
    expect((await post({ ...body, targetMode: 'everyone' })).status).toBe(400);
    expect(state.combineIntoSeries).not.toHaveBeenCalled();
  });

  // W04 final review F3: the fingerprint of the plan the dialog showed is required.
  it('refuses a missing or malformed planFingerprint before touching the service', async () => {
    const { planFingerprint: _omitted, ...withoutFingerprint } = body;
    expect((await post(withoutFingerprint)).status).toBe(400);
    expect((await post({ ...body, planFingerprint: 'B'.repeat(64) })).status).toBe(400);
    expect((await post({ ...body, planFingerprint: 'b'.repeat(63) })).status).toBe(400);
    expect((await post({ ...body, planFingerprint: 42 })).status).toBe(400);
    expect(state.combineIntoSeries).not.toHaveBeenCalled();
  });
});
