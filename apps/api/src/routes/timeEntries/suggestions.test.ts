import { describe, it, expect, vi, beforeEach } from 'vitest';

const { svc, authRef, permsRef, auditMock } = vi.hoisted(() => ({
  svc: {
    listTimeSuggestions: vi.fn(),
    confirmTimeSuggestion: vi.fn(),
    dismissTimeSuggestions: vi.fn(),
    undismissTimeSuggestions: vi.fn(),
  },
  // Same auth shape timeEntries.test.ts installs, so the two files cannot drift
  // on what "partner scope" means.
  authRef: {
    current: {
      scope: 'partner' as string,
      user: { id: '1f2f1d8e-0001-4000-8000-000000000001', name: 'Tess Tech', email: 'tess@msp.example', isPlatformAdmin: false },
      partnerId: 'p-1' as string | null,
      orgId: null as string | null,
      accessibleOrgIds: null as string[] | null,
      orgCondition: () => undefined,
      canAccessOrg: (_id: string) => true as boolean,
    },
  },
  permsRef: { current: { permissions: [{ resource: 'time_entries', action: 'write' }, { resource: 'time_entries', action: 'read' }] } },
  auditMock: vi.fn(),
}));

vi.mock('../../services/timeSuggestionService', () => svc);

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
  // DELIBERATE strengthening over timeEntries.test.ts's permission stub, which
  // only sets c.get('permissions') and never denies: this router's whole point
  // is the gate, and a stub that cannot 403 would make the permission test
  // vacuous. requireScope above is byte-identical so the two files still agree
  // on scope.
  requirePermission: (resource: string, action: string) => async (c: any, next: any) => {
    const perms = permsRef.current.permissions;
    const ok = perms.some((p: { resource: string; action: string }) =>
      (p.resource === '*' || p.resource === resource) && (p.action === '*' || p.action === action));
    if (!ok) return c.json({ error: 'Forbidden' }, 403);
    c.set('permissions', permsRef.current);
    await next();
  },
}));

vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: auditMock }));

import { timeEntriesRoutes } from './index';
import { TimeEntryServiceError } from '../../services/timeEntryService';

const req = (path: string, init?: RequestInit) => timeEntriesRoutes.request(path, init);
const postJson = (path: string, body: unknown) =>
  req(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const UUID = '3f2f1d8e-1111-4222-8333-444455556666';
const SIG = { kind: 'remote_session', id: UUID };
const ACTOR_ID = '1f2f1d8e-0001-4000-8000-000000000001';
const ADMIN_PERMS = { permissions: [{ resource: '*', action: '*' }] };
const NORMAL_PERMS = { permissions: [{ resource: 'time_entries', action: 'write' }, { resource: 'time_entries', action: 'read' }] };

beforeEach(() => {
  Object.values(svc).forEach((m) => m.mockReset());
  auditMock.mockReset();
  authRef.current.scope = 'partner';
  permsRef.current = NORMAL_PERMS;
  svc.listTimeSuggestions.mockResolvedValue({ enabled: true, date: '2026-08-29', timezone: 'UTC', suggestions: [], unloggedCount: 0 });
});

describe('GET /suggestions', () => {
  it('matches the literal path, not /:id (registration order)', async () => {
    const res = await req('/suggestions?date=2026-08-29');
    expect(res.status).toBe(200);
    expect(svc.listTimeSuggestions).toHaveBeenCalled();
    expect(await res.json()).toMatchObject({ data: { enabled: true } });
  });
  it('requires date and rejects a non-ISO date with 400', async () => {
    expect((await req('/suggestions')).status).toBe(400);
    expect((await req('/suggestions?date=29-08-2026')).status).toBe(400);
  });
  it('403 for an org-scoped token (F18)', async () => {
    authRef.current.scope = 'organization';
    expect((await req('/suggestions?date=2026-08-29')).status).toBe(403);
    expect(svc.listTimeSuggestions).not.toHaveBeenCalled();
  });
  it('403 for a caller without time_entries:read', async () => {
    permsRef.current = { permissions: [] };
    expect((await req('/suggestions?date=2026-08-29')).status).toBe(403);
    expect(svc.listTimeSuggestions).not.toHaveBeenCalled();
  });
  it('userId other than the actor requires manageAll (same rule as /timesheet)', async () => {
    const other = '11111111-2222-4333-8444-555566667777';
    expect((await req(`/suggestions?date=2026-08-29&userId=${other}`)).status).toBe(403);
    permsRef.current = ADMIN_PERMS;
    expect((await req(`/suggestions?date=2026-08-29&userId=${other}`)).status).toBe(200);
    expect(svc.listTimeSuggestions).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ userId: other }));
  });
  it('passing your OWN userId never needs manageAll', async () => {
    expect((await req(`/suggestions?date=2026-08-29&userId=${ACTOR_ID}`)).status).toBe(200);
  });
  it('rejects an unknown query key (.strict())', async () => {
    expect((await req('/suggestions?date=2026-08-29&orgId=' + UUID)).status).toBe(400);
  });
  it('maps INVALID_TZ to 400 and the 31-day bound to 400 INVALID_RANGE', async () => {
    svc.listTimeSuggestions.mockRejectedValueOnce(new TimeEntryServiceError('Unknown timezone', 400, 'INVALID_TZ'));
    const bad = await req('/suggestions?date=2026-08-29&tz=Mars/Olympus');
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ code: 'INVALID_TZ' });

    svc.listTimeSuggestions.mockRejectedValueOnce(new TimeEntryServiceError('too old', 400, 'INVALID_RANGE'));
    expect((await req('/suggestions?date=2020-01-01')).status).toBe(400);
  });
  it('returns 200 {enabled:false} rather than 403 when the partner flag is off (F10)', async () => {
    svc.listTimeSuggestions.mockResolvedValueOnce({ enabled: false, date: '2026-08-29', timezone: 'UTC', suggestions: [], unloggedCount: 0 });
    const res = await req('/suggestions?date=2026-08-29');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { enabled: false, suggestions: [] } });
  });
  it('passes the auth scope through to the service actor', async () => {
    await req('/suggestions?date=2026-08-29');
    expect(svc.listTimeSuggestions).toHaveBeenCalledWith(expect.objectContaining({ scope: 'partner', partnerId: 'p-1' }), expect.anything());
  });
});

describe('POST /suggestions/confirm', () => {
  const body = { signals: [SIG], startedAt: '2026-08-29T14:02:00Z', endedAt: '2026-08-29T14:40:00Z' };
  it('201 with the created entry', async () => {
    svc.confirmTimeSuggestion.mockResolvedValue({ entry: { id: 'e1', durationMinutes: 38 }, replay: false });
    const res = await postJson('/suggestions/confirm', body);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ data: { id: 'e1' } });
  });
  it('200 + replay:true when the ledger already points at an entry (F4)', async () => {
    svc.confirmTimeSuggestion.mockResolvedValue({ entry: { id: 'e1', durationMinutes: 38 }, replay: true });
    const res = await postJson('/suggestions/confirm', body);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ replay: true, data: { id: 'e1' } });
  });
  it('REJECTS a client-supplied source / orgId / currency with 400 (D5 — .strict())', async () => {
    for (const extra of [{ source: 'remote_session' }, { orgId: UUID }, { currencyCode: 'USD' }, { currency: 'USD' }]) {
      const res = await postJson('/suggestions/confirm', { ...body, ...extra });
      expect(res.status, JSON.stringify(extra)).toBe(400);
    }
    expect(svc.confirmTimeSuggestion).not.toHaveBeenCalled();
  });
  it('403 for an org-scoped token and for a caller without time_entries:write', async () => {
    authRef.current.scope = 'organization';
    expect((await postJson('/suggestions/confirm', body)).status).toBe(403);
    authRef.current.scope = 'partner';
    permsRef.current = { permissions: [{ resource: 'time_entries', action: 'read' }] };
    expect((await postJson('/suggestions/confirm', body)).status).toBe(403);
    expect(svc.confirmTimeSuggestion).not.toHaveBeenCalled();
  });
  it('maps every service error code to its status', async () => {
    const cases: Array<[string, number]> = [
      ['SUGGESTIONS_DISABLED', 403], ['SIGNAL_NOT_FOUND', 404], ['SIGNAL_NOT_ENDED', 409],
      ['SUGGESTION_DISMISSED', 409], ['SUGGESTION_PARTIALLY_LOGGED', 409], ['SUGGESTION_ENTRY_DELETED', 410], ['ORG_MISMATCH', 422],
      ['ENDED_AT_REQUIRED', 400], ['RANGE_OUTSIDE_SIGNAL', 400], ['TICKET_NOT_FOUND', 404],
    ];
    for (const [code, status] of cases) {
      svc.confirmTimeSuggestion.mockRejectedValueOnce(new TimeEntryServiceError(code, status as never, code as never));
      const res = await postJson('/suggestions/confirm', body);
      expect(res.status, code).toBe(status);
      expect(await res.json()).toMatchObject({ code });
    }
  });
  it('writes an audit row for the created entry', async () => {
    svc.confirmTimeSuggestion.mockImplementation(async (_i: unknown, actor: any) => {
      actor.recordAuditMutation({ action: 'time_entry.created', entryId: 'e1', orgId: 'o1', source: 'remote_session' });
      return { entry: { id: 'e1' }, replay: false };
    });
    await postJson('/suggestions/confirm', body);
    expect(auditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      resourceType: 'time_entry', details: expect.objectContaining({ source: 'remote_session' }),
    }));
  });
});

describe('POST|DELETE /suggestions/dismiss', () => {
  it('POST returns 204 and is idempotent', async () => {
    svc.dismissTimeSuggestions.mockResolvedValue(undefined);
    expect((await postJson('/suggestions/dismiss', { signals: [SIG] })).status).toBe(204);
    expect((await postJson('/suggestions/dismiss', { signals: [SIG] })).status).toBe(204);
  });
  it('DELETE (un-dismiss) returns 204', async () => {
    svc.undismissTimeSuggestions.mockResolvedValue(undefined);
    const res = await req('/suggestions/dismiss', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signals: [SIG] }) });
    expect(res.status).toBe(204);
    expect(svc.undismissTimeSuggestions).toHaveBeenCalled();
  });
  it('both reject an unknown body key (.strict())', async () => {
    expect((await postJson('/suggestions/dismiss', { signals: [SIG], reason: 'nope' })).status).toBe(400);
    const res = await req('/suggestions/dismiss', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signals: [SIG], reason: 'nope' }) });
    expect(res.status).toBe(400);
  });
  it('403 when the flag is off', async () => {
    svc.dismissTimeSuggestions.mockRejectedValueOnce(new TimeEntryServiceError('off', 403, 'SUGGESTIONS_DISABLED'));
    expect((await postJson('/suggestions/dismiss', { signals: [SIG] })).status).toBe(403);
  });
  it('403 for a caller without time_entries:write', async () => {
    permsRef.current = { permissions: [{ resource: 'time_entries', action: 'read' }] };
    expect((await postJson('/suggestions/dismiss', { signals: [SIG] })).status).toBe(403);
    expect(svc.dismissTimeSuggestions).not.toHaveBeenCalled();
  });
  it('files the dismissal audit under resourceType time_suggestion, not time_entry', async () => {
    svc.dismissTimeSuggestions.mockImplementation(async (_signals: unknown, actor: any) => {
      actor.recordAuditMutation({ action: 'time_suggestion.dismissed', entryId: 'sig-1', orgId: null });
    });
    await postJson('/suggestions/dismiss', { signals: [SIG] });
    expect(auditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'time_suggestion.dismissed', resourceType: 'time_suggestion',
    }));
  });
});
