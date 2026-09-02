import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Regression for Finding #6 (MEDIUM): alert state-change endpoints
// (acknowledge/resolve/suppress/bulk) must gate on an alert RBAC permission in
// addition to scope tier. acknowledge -> ALERTS_ACKNOWLEDGE; resolve/suppress ->
// ALERTS_WRITE (mirrors the mobile alert routes). /bulk is PER ACTION: a bulk
// acknowledge accepts ALERTS_ACKNOWLEDGE or ALERTS_WRITE, every other action
// still demands ALERTS_WRITE.

const { authRef, grantedRef, permsHookRef, permsCallsRef, trackedGetUserPermissions, state, tables, dbMock } = vi.hoisted(() => {
  // ONE tracked permission lookup, shared by the permissions mock AND the auth
  // mock's requirePermission, so the ordering test's call count reflects every
  // ROUTE-LEVEL resolution. It is not a whole-request count: this suite mounts
  // the alerts router without production `authMiddleware`, which resolves
  // permissions of its own for organization scope.
  const grantedRef = { current: new Set<string>() };
  const permsCallsRef = { current: 0 };
  const permsHookRef = { current: null as null | ((call: number) => void) };
  const trackedGetUserPermissions = async () => {
    permsCallsRef.current += 1;
    permsHookRef.current?.(permsCallsRef.current);
    return { granted: grantedRef.current };
  };
  const tables = {
    alerts: { id: 'alerts.id', orgId: 'alerts.orgId', deviceId: 'alerts.deviceId', status: 'alerts.status' },
    devices: { id: 'devices.id', siteId: 'devices.siteId', orgId: 'devices.orgId' },
    tickets: { id: 'tickets.id', deviceId: 'tickets.deviceId' },
  };

  type Predicate = { op: string; col?: unknown; val?: unknown; vals?: unknown[]; args?: Predicate[] } | undefined;
  const columnKey = (col: unknown) => String(col).split('.').pop()!;
  const evalPredicate = (row: Record<string, unknown>, predicate: Predicate): boolean => {
    if (!predicate) return true;
    if (predicate.op === 'eq') return row[columnKey(predicate.col)] === predicate.val;
    if (predicate.op === 'ne') return row[columnKey(predicate.col)] !== predicate.val;
    if (predicate.op === 'inArray') return (predicate.vals ?? []).includes(row[columnKey(predicate.col)]);
    if (predicate.op === 'and') return (predicate.args ?? []).every((arg) => evalPredicate(row, arg));
    if (predicate.op === 'or') return (predicate.args ?? []).some((arg) => evalPredicate(row, arg));
    return true;
  };

  const state = {
    alerts: [] as Array<Record<string, any>>,
    devices: [] as Array<Record<string, any>>,
  };

  class SelectQuery {
    private predicate: Predicate;
    constructor(private table: unknown, private projection?: Record<string, unknown>) {}
    where(predicate: Predicate) { this.predicate = predicate; return this; }
    orderBy() { return this; }
    limit(limit: number) { return Promise.resolve(this.rows().slice(0, limit)); }
    then(resolve: (value: unknown[]) => void, reject?: (reason: unknown) => void) {
      return Promise.resolve(this.rows()).then(resolve, reject);
    }
    private rows() {
      const source = this.table === tables.alerts ? state.alerts : state.devices;
      const filtered = source.filter((row) => evalPredicate(row, this.predicate));
      if (!this.projection) return filtered;
      return filtered.map((row) => {
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(this.projection!)) out[key] = row[columnKey(this.projection![key])];
        return out;
      });
    }
  }

  const dbMock = {
    select: vi.fn((projection?: Record<string, unknown>) => ({
      from: (table: unknown) => new SelectQuery(table, projection),
    })),
    update: vi.fn((table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: (predicate: Predicate) => {
          const source = table === tables.alerts ? state.alerts : [];
          const written: Array<Record<string, unknown>> = [];
          for (const row of source) {
            if (!evalPredicate(row, predicate)) continue;
            Object.assign(row, values);
            written.push(row);
          }
          return {
            returning: () => Promise.resolve(written),
            then: (resolve: (value: unknown[]) => void, reject?: (reason: unknown) => void) =>
              Promise.resolve(written.map(() => ({}))).then(resolve, reject),
          };
        },
      }),
    })),
  };

  return {
    authRef: {
      current: {
        scope: 'organization' as string,
        user: { id: 'u-1', name: 'Reed Only', email: 'reed@org.example' },
        partnerId: null as string | null,
        orgId: 'org-1' as string | null,
        accessibleOrgIds: null as string[] | null,
        allowedSiteIds: undefined as string[] | undefined,
        canAccessOrg: (_id: string) => true as boolean,
      },
    },
    grantedRef,
    permsCallsRef,
    trackedGetUserPermissions,
    // Fires on every getUserPermissions call, so a test can model state changing
    // BETWEEN the pre-gate's lookup and the handler's.
    permsHookRef,
    state,
    tables,
    dbMock,
  };
});

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  ne: (col: unknown, val: unknown) => ({ op: 'ne', col, val }),
  gte: (col: unknown, val: unknown) => ({ op: 'gte', col, val }),
  lte: (col: unknown, val: unknown) => ({ op: 'lte', col, val }),
  and: (...args: unknown[]) => ({ op: 'and', args }),
  or: (...args: unknown[]) => ({ op: 'or', args }),
  inArray: (col: unknown, vals: unknown[]) => ({ op: 'inArray', col, vals }),
  isNull: (col: unknown) => ({ op: 'isNull', col }),
  desc: (col: unknown) => ({ op: 'desc', col }),
  sql: Object.assign(() => ({ op: 'sql' }), { raw: () => ({ op: 'sql' }) }),
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn(async (_c: any, next: any) => next()),
  requireScope: () => async (c: any, next: any) => {
    if (!authRef.current) return c.json({ error: 'Not authenticated' }, 401);
    c.set('auth', authRef.current);
    await next();
  },
  // Mirrors production in the ONE respect the ordering test depends on: real
  // `requirePermission` resolves the permission set via `getUserPermissions`.
  // While this mock answered straight from `grantedRef`, re-introducing a
  // `requirePermission(...)` ahead of the bulk handler would have added a REAL
  // pre-body lookup in production while `permsCalls` stayed at 1 here — the
  // ordering test would have passed through exactly the regression it exists to
  // catch. It must go through the tracked lookup for that count to mean
  // anything.
  requirePermission: (resource: string, action: string) => async (c: any, next: any) => {
    const perms = await trackedGetUserPermissions();
    if (!perms?.granted?.has(`${resource}:${action}`)) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    c.set('permissions', { allowedSiteIds: authRef.current?.allowedSiteIds });
    await next();
  },
  requireMfa: () => async (_c: any, next: any) => next(),
  // Used by filterAlertsBySiteScope / deviceInSiteScope (real ../tickets/siteScope).
  siteAccessCheck: (allowedSiteIds?: string[]) => (siteId: string | null | undefined) => {
    if (!allowedSiteIds) return true;
    if (!siteId) return false;
    return allowedSiteIds.includes(siteId);
  },
}));

// The /bulk gate moved from `requirePermission` middleware into the handler
// (it needs `action`, which only exists after the body is parsed), so the test
// must now drive the permission SOURCE as well as the middleware. Partial mock
// on purpose: `canAccessSite` and `PERMISSIONS` are real, because the
// site-scope suite below depends on their actual behaviour.
vi.mock('../../services/permissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/permissions')>();
  return {
    ...actual,
    getUserPermissions: trackedGetUserPermissions,
    hasPermission: (perms: unknown, resource: string, action: string) =>
      (perms as { granted?: Set<string> })?.granted?.has(`${resource}:${action}`) ?? false,
  };
});

vi.mock('../../db', () => ({ db: dbMock }));
vi.mock('../../db/schema', () => ({
  alertCorrelationGroups: {}, alertCorrelationMembers: {},
  alertRules: {}, alertTemplates: {}, alerts: tables.alerts, notificationChannels: {},
  alertNotifications: {}, devices: tables.devices, tickets: tables.tickets, ticketAlertLinks: {},
}));
vi.mock('../../services/alertCooldown', () => ({
  setCooldown: vi.fn(), markConfigPolicyRuleCooldown: vi.fn(),
}));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../../services/eventBus', () => ({ publishEvent: vi.fn() }));
vi.mock('../../services/mlFeedbackEmitters', () => ({
  emitAlertStateFeedback: vi.fn(),
  emitCorrelationFeedback: vi.fn(),
}));
vi.mock('../../services/ticketService', () => ({
  createTicketFromAlert: vi.fn(),
  TicketServiceError: class TicketServiceError extends Error { status = 400; },
}));
vi.mock('./helpers', () => ({
  getPagination: vi.fn(() => ({ page: 1, limit: 50, offset: 0 })),
  ensureOrgAccess: vi.fn(() => true),
  getAlertWithOrgCheck: vi.fn(),
}));
// Phase 2 wave P2-1 (alert verdicts), Task 14 — `alerts.ts` now imports
// `latestVerdictsForAlerts`/`projectAlertAiVerdictSummary`. Unmocked, the
// real module drags in `createActionIntent` (services/actionIntents/
// intentService.ts) and its own transitive graph (aiTools/aiToolSchemas,
// commandQueue, …), which this file's other partial mocks were never built
// to cover. Mocked here purely to sever that transitive chain — this suite
// doesn't exercise aiVerdict at all.
vi.mock('../../services/aiAgents/alertVerdicts', () => ({
  latestVerdictsForAlerts: vi.fn(async () => new Map()),
  projectAlertAiVerdictSummary: vi.fn(),
}));

import { alertsRoutes, attachAlertCorrelationSummaries } from './alerts';
import { getAlertWithOrgCheck } from './helpers';

function makeApp() {
  const app = new Hono();
  app.route('/alerts', alertsRoutes);
  return app;
}

const ALERT_ID = '5d4c3b2a-1111-4222-8333-444455556666';
const ALERTS_WRITE = 'alerts:write';
const ALERTS_ACKNOWLEDGE = 'alerts:acknowledge';

describe('alert state-change authz (Finding #6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    grantedRef.current = new Set<string>();
    permsHookRef.current = null;
    permsCallsRef.current = 0;
    authRef.current = {
      scope: 'organization',
      user: { id: 'u-1', name: 'Reed Only', email: 'reed@org.example' },
      partnerId: null, orgId: 'org-1', accessibleOrgIds: null, allowedSiteIds: undefined, canAccessOrg: () => true,
    } as typeof authRef.current;
  });

  it('403 on POST /alerts/:id/acknowledge without ALERTS_ACKNOWLEDGE', async () => {
    const res = await makeApp().request(`/alerts/${ALERT_ID}/acknowledge`, { method: 'POST' });
    expect(res.status).toBe(403);
  });

  it('403 on POST /alerts/:id/resolve without ALERTS_WRITE', async () => {
    const res = await makeApp().request(`/alerts/${ALERT_ID}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
  });

  it('403 on POST /alerts/:id/suppress without ALERTS_WRITE', async () => {
    const res = await makeApp().request(`/alerts/${ALERT_ID}/suppress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ until: '2030-01-01T00:00:00.000Z' }),
    });
    expect(res.status).toBe(403);
  });

  it('403 on POST /alerts/bulk with NEITHER alert permission', async () => {
    const res = await makeApp().request('/alerts/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alertIds: [ALERT_ID], action: 'acknowledge' }),
    });
    expect(res.status).toBe(403);
  });

  /**
   * The gate is in TWO parts, and this is what the coarse half buys — for a
   * caller holding NEITHER alert permission. An acknowledge-only caller is
   * unauthorised for resolve/suppress/dismiss and still distinguishes 400 from
   * 403, because the action-specific check has to run after the parse.
   *
   * The action-specific check can only run after the body is parsed. On its own
   * that let a caller holding NO alert permission reach `zValidator` and tell a
   * well-formed body from a malformed one by the status — a schema oracle for a
   * route they cannot use at all. The coarse gate runs first, so both shapes
   * come back 403 and nothing about the schema leaks.
   *
   * Paired deliberately with the authorised test BELOW, which sends the SAME
   * malformed body and gets 400 — so this asserts the ORDERING, not just that
   * a 403 appears somewhere.
   */
  it('403, NOT 400, on a malformed body when the caller holds neither permission', async () => {
    const res = await makeApp().request('/alerts/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alertIds: 'not-an-array', action: 'nonsense' }),
    });
    expect(res.status).toBe(403);
  });

  it('passes the acknowledge gate when ALERTS_ACKNOWLEDGE is granted', async () => {
    grantedRef.current.add(ALERTS_ACKNOWLEDGE);
    const res = await makeApp().request(`/alerts/${ALERT_ID}/acknowledge`, { method: 'POST' });
    expect(res.status).not.toBe(403);
  });

  it('passes the bulk gate when ALERTS_WRITE is granted', async () => {
    grantedRef.current.add(ALERTS_WRITE);
    const res = await makeApp().request('/alerts/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // The SAME malformed body the unauthorised test ABOVE sends. Paired on
      // purpose: authorised -> 400 (validation speaks), unauthorised -> 403
      // (the gate speaks first). Asserting only "not 403" here would not
      // establish that contrast.
      body: JSON.stringify({ alertIds: 'not-an-array', action: 'nonsense' }),
    });
    // 400 exactly. `not.toBe(403)` is satisfied by a 404 or a 500 and would not
    // show that VALIDATION is what answered.
    expect(res.status).toBe(400);
  });

  /**
   * Per-action bulk gate. A bulk acknowledge is N single acknowledges, which
   * ALERTS_ACKNOWLEDGE already permits one at a time, so requiring ALERTS_WRITE
   * for the batched form granted no extra safety — it only denied the batched
   * form to the role that triages alerts, which is what forced the mobile
   * client into a per-alert queue that loses work when backgrounded mid-flush.
   *
   * The matrix below is the whole contract: acknowledge opens up, everything
   * else stays shut.
   */
  const bulkAs = (action: string) =>
    makeApp().request('/alerts/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alertIds: [ALERT_ID], action, ...(action === 'suppress' ? { until: '2030-01-01T00:00:00.000Z' } : {}) }),
    });

  it('ALERTS_ACKNOWLEDGE alone CAN bulk-acknowledge', async () => {
    grantedRef.current.add(ALERTS_ACKNOWLEDGE);
    // 404, not merely "not 403": the fixture seeds no alerts, so passing the
    // gate lands on the handler's empty-result branch. `not.toBe(403)` was
    // satisfied by a 500 too, which is not evidence the gate opened.
    expect((await bulkAs('acknowledge')).status).toBe(404);
  });

  /**
   * The coarse pre-gate must not become the authorisation of record.
   *
   * A permission-checking middleware ahead of the validator is the obvious
   * shape and is the wrong one: it would resolve permissions BEFORE the body is
   * read, and the client controls when the body arrives. `getUserPermissions`
   * caches locally, and `middleware/auth.ts` warms that cache only for
   * ORGANIZATION scope — so on the partner path a pre-body gate would be a
   * new route-level LOOKUP, warming that entry only if it was cold, and the
   * authorising read could then return the gate's own entry (a successful
   * intervening version bump would still force a refresh).
   * (NOT "a cold read that reaches the database": the cache is process-global,
   * so a partner entry may already be warm — this is a new LOOKUP, which warms
   * that entry only if it was cold. And NOT "adds no new warm" either
   * — the lookup now precedes the media-type and schema checks, so an
   * invalid-body request performs one where `zValidator` used to reject it
   * first. The precise claim is narrower: no ROUTE-LEVEL authorising lookup
   * happens before the body is consumed — organization-scope `authMiddleware`
   * resolves permissions earlier regardless — and a request that would
   * previously have reached the handler gains no extra route-level lookup.)
   *
   * So this observes the ORDERING directly — was the body already consumed when
   * the permission lookup ran? Counting lookups does not: with a single lookup
   * moved ABOVE `c.req.json()` the count is still one and a count-based test
   * stays green while the invariant is broken.
   *
   * SCOPE OF THE COUNT ASSERTION: this suite mounts the alerts router directly,
   * without production `authMiddleware`. So "exactly one" is one lookup BY THIS
   * ROUTE — it is not a claim about the whole request, which for an
   * organization-scope caller also warms the cache in auth middleware. The
   * ordering assertion above is the load-bearing one; the count only guards
   * against a second route-level lookup creeping back in.
   */
  it('resolves permissions only AFTER the request body has been consumed', async () => {
    grantedRef.current.add(ALERTS_WRITE);
    let bodyPulled = false;
    let pulledAtLookup: boolean | null = null;
    permsHookRef.current = () => { pulledAtLookup = bodyPulled; };

    // A streamed body, so "was it read yet" is observable rather than inferred.
    const payload = new TextEncoder().encode(
      JSON.stringify({ alertIds: [ALERT_ID], action: 'resolve' })
    );
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        bodyPulled = true;
        controller.enqueue(payload);
        controller.close();
      },
    });

    await makeApp().request(
      new Request('http://localhost/alerts/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: stream,
        // Node requires this for a streaming request body.
        duplex: 'half',
      } as RequestInit & { duplex: 'half' })
    );

    expect(pulledAtLookup, 'permissions were resolved BEFORE the body was read').toBe(true);
    expect(permsCallsRef.current, 'expected exactly one permission lookup').toBe(1);
  });

  /**
   * Dropping `zValidator` from this route dropped its media-type check with it.
   * `c.req.json()` parses a valid JSON payload whatever the Content-Type says,
   * so without an explicit gate a `text/plain` body would reach the mutation
   * where it used to be rejected — a quiet widening of what the endpoint
   * accepts, introduced by a change that was only about authorisation ordering.
   *
   * The cases below are chosen to SEPARATE Hono's predicate from a plausible
   * hand-rolled one. An earlier version of this gate used
   * `^application\/(\w+\+)?json\b`, which agrees with Hono on `application/json`
   * and `text/plain` — so testing only those proved nothing. It disagrees on
   * exactly these three, in both directions:
   *   - `application/json-bogus`   -> hand-rolled ACCEPTS, Hono rejects (the
   *      dangerous direction: a body reaching the mutation)
   *   - `application/vnd.api+json` -> hand-rolled rejects, Hono ACCEPTS
   *   - `application/merge-patch+json` -> same
   * Verified against the installed Hono 4.13.2, which is why the shared helper
   * copies its regex rather than approximating it.
   *
   * The gate deliberately sits BELOW the coarse permission check, so it cannot
   * become an oracle FOR A CALLER HOLDING NEITHER PERMISSION. An
   * acknowledge-only caller is unauthorised for resolve/suppress/dismiss and
   * can still receive this 400 — the action-specific check necessarily runs
   * after the parse, so that distinction is unavoidable here.
   */
  const withContentType = (ct: string) =>
    makeApp().request('/alerts/bulk', {
      method: 'POST',
      headers: { 'Content-Type': ct },
      body: JSON.stringify({ alertIds: [ALERT_ID], action: 'resolve' }),
    });

  // 404 = the seeded fixture has no alerts, i.e. it passed every gate.
  it.each([
    'application/json',
    'application/json; charset=utf-8',
    'application/vnd.api+json',
    'application/merge-patch+json',
  ])('accepts %s, as Hono does', async (ct) => {
    grantedRef.current.add(ALERTS_WRITE);
    expect((await withContentType(ct)).status).toBe(404);
  });

  it.each([
    'text/plain',
    'application/json-bogus',
    'application/xml',
  ])('rejects %s with 400, as Hono does', async (ct) => {
    grantedRef.current.add(ALERTS_WRITE);
    expect((await withContentType(ct)).status).toBe(400);
  });

  /**
   * Every body-shaped verdict must stay BELOW the coarse permission check.
   *
   * The existing oracle test sends syntactically valid JSON, so a `400` raised
   * from the `c.req.json()` catch — before RBAC — would keep it green. And the
   * media-type cases above all run WITH `ALERTS_WRITE`, so moving that verdict
   * above the coarse gate would keep them green too. These close both: an
   * unauthorised caller learns nothing about the body, whatever is wrong with
   * it.
   */
  it('403, not 400, on unparseable JSON when the caller holds neither permission', async () => {
    const res = await makeApp().request('/alerts/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });
    expect(res.status).toBe(403);
  });

  it.each(['text/plain', 'application/json-bogus'])(
    '403, not 400, on Content-Type %s when the caller holds neither permission',
    async (ct) => {
      const res = await makeApp().request('/alerts/bulk', {
        method: 'POST',
        headers: { 'Content-Type': ct },
        body: JSON.stringify({ alertIds: [ALERT_ID], action: 'resolve' }),
      });
      expect(res.status).toBe(403);
    },
  );

  it.each(['resolve', 'suppress', 'dismiss'])(
    'ALERTS_ACKNOWLEDGE alone is still 403 on bulk-%s',
    async (action) => {
      grantedRef.current.add(ALERTS_ACKNOWLEDGE);
      expect((await bulkAs(action)).status).toBe(403);
    },
  );

  it.each(['acknowledge', 'resolve', 'suppress', 'dismiss'])(
    'ALERTS_WRITE alone still passes bulk-%s',
    async (action) => {
      grantedRef.current.add(ALERTS_WRITE);
      expect((await bulkAs(action)).status).not.toBe(403);
    },
  );
});

// Site-axis enforcement on POST /alerts/bulk (T3, #1051 class). RLS does NOT
// enforce site scope; a site-restricted org user must not bulk ack/resolve
// alerts on devices outside their allowed sites.
describe('POST /alerts/bulk site-axis scope (T3)', () => {
  const ORG = 'org-1';
  const SITE_A = '5a5a5a5a-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const SITE_B = '5b5b5b5b-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const DEVICE_A = 'd1d1d1d1-dddd-4ddd-8ddd-dddddddddddd';
  const DEVICE_B = 'd2d2d2d2-dddd-4ddd-8ddd-dddddddddddd';
  const ALERT_A = 'a1a1a1a1-1111-4111-8111-111111111111';
  const ALERT_B = 'a2a2a2a2-2222-4222-8222-222222222222';
  const ALERT_ORGWIDE = 'a3a3a3a3-3333-4333-8333-333333333333';

  beforeEach(() => {
    vi.clearAllMocks();
    grantedRef.current = new Set<string>(['alerts:write']);
    authRef.current = {
      scope: 'organization',
      user: { id: 'u-1', name: 'Reed Only', email: 'reed@org.example' },
      partnerId: null, orgId: ORG, accessibleOrgIds: null,
      allowedSiteIds: undefined, canAccessOrg: () => true,
    } as typeof authRef.current;
    state.devices = [
      { id: DEVICE_A, siteId: SITE_A, orgId: ORG },
      { id: DEVICE_B, siteId: SITE_B, orgId: ORG },
    ];
    state.alerts = [
      { id: ALERT_A, orgId: ORG, deviceId: DEVICE_A, status: 'active', ruleId: 'r-a' },
      { id: ALERT_B, orgId: ORG, deviceId: DEVICE_B, status: 'active', ruleId: 'r-b' },
      { id: ALERT_ORGWIDE, orgId: ORG, deviceId: null, status: 'active', ruleId: 'r-org' },
    ];
  });

  it('does not acknowledge a SITE_B alert for a SITE_A-restricted user', async () => {
    authRef.current = { ...authRef.current, allowedSiteIds: [SITE_A] } as typeof authRef.current;

    const res = await makeApp().request('/alerts/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alertIds: [ALERT_A, ALERT_B], action: 'acknowledge' }),
    });

    expect(res.status).toBe(200);
    expect(state.alerts.find((a) => a.id === ALERT_A)?.status).toBe('acknowledged');
    expect(state.alerts.find((a) => a.id === ALERT_B)?.status).toBe('active');
  });

  it('returns 404 (no writes) when every alertId is out-of-site for a SITE_A-restricted user', async () => {
    authRef.current = { ...authRef.current, allowedSiteIds: [SITE_A] } as typeof authRef.current;

    const res = await makeApp().request('/alerts/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alertIds: [ALERT_B], action: 'acknowledge' }),
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'No accessible alerts found' });
    // No alert was mutated.
    expect(state.alerts.find((a) => a.id === ALERT_B)?.status).toBe('active');
  });

  it('still acknowledges org-wide (deviceless) alerts for a SITE_A-restricted user', async () => {
    authRef.current = { ...authRef.current, allowedSiteIds: [SITE_A] } as typeof authRef.current;

    const res = await makeApp().request('/alerts/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alertIds: [ALERT_ORGWIDE, ALERT_B], action: 'acknowledge' }),
    });

    expect(res.status).toBe(200);
    expect(state.alerts.find((a) => a.id === ALERT_ORGWIDE)?.status).toBe('acknowledged');
    expect(state.alerts.find((a) => a.id === ALERT_B)?.status).toBe('active');
  });

  it('acknowledges alerts across all sites for an unrestricted user (no regression)', async () => {
    const res = await makeApp().request('/alerts/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alertIds: [ALERT_A, ALERT_B], action: 'acknowledge' }),
    });

    expect(res.status).toBe(200);
    expect(state.alerts.find((a) => a.id === ALERT_A)?.status).toBe('acknowledged');
    expect(state.alerts.find((a) => a.id === ALERT_B)?.status).toBe('acknowledged');
  });
});

// Bulk suppress (PR #2020 follow-up): the bulk endpoint must accept
// action:'suppress' with a future `until`, set suppressedUntil, skip resolved
// alerts, and reject a past deadline. A missing `until` means indefinite
// ("Forever") suppression — suppressedUntil is left null.
describe('POST /alerts/bulk suppress', () => {
  const ORG = 'org-1';
  const ALERT_A = 'a1a1a1a1-1111-4111-8111-111111111111';
  const ALERT_B = 'a2a2a2a2-2222-4222-8222-222222222222';
  const ALERT_RESOLVED = 'a4a4a4a4-4444-4444-8444-444444444444';
  const FUTURE = '2999-01-01T00:00:00.000Z';

  beforeEach(() => {
    vi.clearAllMocks();
    grantedRef.current = new Set<string>(['alerts:write']);
    authRef.current = {
      scope: 'organization',
      user: { id: 'u-1', name: 'Reed Only', email: 'reed@org.example' },
      partnerId: null, orgId: ORG, accessibleOrgIds: null,
      allowedSiteIds: undefined, canAccessOrg: () => true,
    } as typeof authRef.current;
    state.devices = [];
    state.alerts = [
      { id: ALERT_A, orgId: ORG, deviceId: null, status: 'active', ruleId: 'r-a' },
      { id: ALERT_B, orgId: ORG, deviceId: null, status: 'acknowledged', ruleId: 'r-b' },
      { id: ALERT_RESOLVED, orgId: ORG, deviceId: null, status: 'resolved', ruleId: 'r-r' },
    ];
  });

  it('suppresses active + acknowledged alerts until the given deadline', async () => {
    const res = await makeApp().request('/alerts/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alertIds: [ALERT_A, ALERT_B], action: 'suppress', until: FUTURE }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ updated: 2, skipped: 0 });
    const a = state.alerts.find((x) => x.id === ALERT_A)!;
    expect(a.status).toBe('suppressed');
    expect(new Date(a.suppressedUntil).toISOString()).toBe(FUTURE);
    expect(state.alerts.find((x) => x.id === ALERT_B)?.status).toBe('suppressed');
  });

  it('skips resolved alerts (cannot suppress a resolved alert)', async () => {
    const res = await makeApp().request('/alerts/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alertIds: [ALERT_A, ALERT_RESOLVED], action: 'suppress', until: FUTURE }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ updated: 1, skipped: 1 });
    expect(state.alerts.find((x) => x.id === ALERT_RESOLVED)?.status).toBe('resolved');
  });

  it('suppresses indefinitely (Forever) when `until` is omitted', async () => {
    const res = await makeApp().request('/alerts/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alertIds: [ALERT_A], action: 'suppress' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ updated: 1, skipped: 0 });
    const a = state.alerts.find((x) => x.id === ALERT_A)!;
    expect(a.status).toBe('suppressed');
    // Forever == no deadline: suppressedUntil is left null.
    expect(a.suppressedUntil).toBeNull();
  });

  it('400 when `until` is in the past', async () => {
    const res = await makeApp().request('/alerts/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alertIds: [ALERT_A], action: 'suppress', until: '2000-01-01T00:00:00.000Z' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Suppression time must be in the future' });
    expect(state.alerts.find((x) => x.id === ALERT_A)?.status).toBe('active');
  });
});

// Permanent dismissal: valid from ANY non-dismissed status (including resolved —
// that's the entire point), terminal once applied.
describe('alert dismiss', () => {
  const ORG = 'org-1';
  const ALERT_ACTIVE = 'a1a1a1a1-1111-4111-8111-111111111111';
  const ALERT_RESOLVED = 'a4a4a4a4-4444-4444-8444-444444444444';
  const ALERT_DISMISSED = 'a5a5a5a5-5555-4555-8555-555555555555';

  beforeEach(() => {
    vi.clearAllMocks();
    grantedRef.current = new Set<string>(['alerts:write']);
    authRef.current = {
      scope: 'organization',
      user: { id: 'u-1', name: 'Reed Only', email: 'reed@org.example' },
      partnerId: null, orgId: ORG, accessibleOrgIds: null,
      allowedSiteIds: undefined, canAccessOrg: () => true,
    } as typeof authRef.current;
    state.devices = [];
    state.alerts = [
      { id: ALERT_ACTIVE, orgId: ORG, deviceId: null, status: 'active', ruleId: 'r-a', title: 'Active alert' },
      { id: ALERT_RESOLVED, orgId: ORG, deviceId: null, status: 'resolved', ruleId: 'r-r', title: 'Warranty expired: X' },
      { id: ALERT_DISMISSED, orgId: ORG, deviceId: null, status: 'dismissed', ruleId: 'r-d', title: 'Old dismissed' },
    ];
  });

  it('403 on POST /alerts/:id/dismiss without ALERTS_WRITE', async () => {
    grantedRef.current = new Set<string>();
    const res = await makeApp().request(`/alerts/${ALERT_RESOLVED}/dismiss`, { method: 'POST' });
    expect(res.status).toBe(403);
  });

  it('dismisses a RESOLVED alert via POST /alerts/:id/dismiss and stamps dismissedAt/dismissedBy', async () => {
    (getAlertWithOrgCheck as ReturnType<typeof vi.fn>).mockResolvedValue(
      state.alerts.find((a) => a.id === ALERT_RESOLVED)
    );
    const res = await makeApp().request(`/alerts/${ALERT_RESOLVED}/dismiss`, { method: 'POST' });

    expect(res.status).toBe(200);
    const row = state.alerts.find((a) => a.id === ALERT_RESOLVED)!;
    expect(row.status).toBe('dismissed');
    expect(row.dismissedAt).toBeInstanceOf(Date);
    expect(row.dismissedBy).toBe('u-1');
  });

  it('409 when the alert is already dismissed', async () => {
    (getAlertWithOrgCheck as ReturnType<typeof vi.fn>).mockResolvedValue(
      state.alerts.find((a) => a.id === ALERT_DISMISSED)
    );
    const res = await makeApp().request(`/alerts/${ALERT_DISMISSED}/dismiss`, { method: 'POST' });
    // 409, not the 400 this returned before #4293. Once the UPDATE became a
    // compare-and-swap that answers 409 when it loses, keeping this branch at 400
    // would have made the response code depend purely on whether the other dismissal
    // landed before or after this request's pre-read — the split #4099 and #4288
    // removed from resolve and acknowledge respectively.
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Alert is already dismissed' });
  });

  it('bulk dismiss updates active + resolved alerts and skips already-dismissed ones', async () => {
    const res = await makeApp().request('/alerts/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alertIds: [ALERT_ACTIVE, ALERT_RESOLVED, ALERT_DISMISSED], action: 'dismiss' }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ updated: 2, skipped: 1 });
    expect(state.alerts.find((x) => x.id === ALERT_ACTIVE)?.status).toBe('dismissed');
    expect(state.alerts.find((x) => x.id === ALERT_RESOLVED)?.status).toBe('dismissed');
    expect(state.alerts.find((x) => x.id === ALERT_RESOLVED)?.dismissedBy).toBe('u-1');
  });

  it('cannot resolve or suppress a dismissed alert (terminal)', async () => {
    (getAlertWithOrgCheck as ReturnType<typeof vi.fn>).mockResolvedValue(
      state.alerts.find((a) => a.id === ALERT_DISMISSED)
    );
    const resolveRes = await makeApp().request(`/alerts/${ALERT_DISMISSED}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(resolveRes.status).toBe(400);

    const suppressRes = await makeApp().request(`/alerts/${ALERT_DISMISSED}/suppress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(suppressRes.status).toBe(400);
    expect(state.alerts.find((x) => x.id === ALERT_DISMISSED)?.status).toBe('dismissed');
  });
});

describe('attachAlertCorrelationSummaries', () => {
  it('adds group child count and noise reduction fields to visible alert rows', () => {
    const [alert] = attachAlertCorrelationSummaries(
      [{ id: ALERT_ID, title: 'High CPU' }],
      [{
        alertId: ALERT_ID,
        groupId: '6f5e4d3c-2222-4333-8444-555566667777',
        role: 'root',
        groupStatus: 'open',
        memberCount: 4,
        noiseReductionPercent: 75,
      }]
    );

    expect(alert).toEqual(expect.objectContaining({
      correlationGroupId: '6f5e4d3c-2222-4333-8444-555566667777',
      correlationRole: 'root',
      correlationGroupStatus: 'open',
      correlationMemberCount: 4,
      correlationChildCount: 3,
      noiseReductionPercent: 75,
    }));
  });

  it('returns explicit empty correlation fields when an alert is not grouped', () => {
    const [alert] = attachAlertCorrelationSummaries([{ id: ALERT_ID, title: 'High CPU' }], []);

    expect(alert).toEqual(expect.objectContaining({
      correlationGroupId: null,
      correlationRole: null,
      correlationGroupStatus: null,
      correlationMemberCount: 0,
      correlationChildCount: 0,
      noiseReductionPercent: null,
    }));
  });
});
