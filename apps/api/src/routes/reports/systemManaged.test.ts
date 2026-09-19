/**
 * P2-3 (#4190) — a SYSTEM-managed report definition is read-only to humans.
 *
 * The weekly AI narrative's definition is created and owned by the agent
 * scheduler (`persistNarrativeReport`), carries `execution_scope_principal_kind
 * = 'system'` and has no acting user at all. Task 3 widened the report scope
 * predicates so an ORG-WIDE reader can see and download it — which is the
 * point, an MSP has to be able to open the report — but that same widening put
 * it in reach of every org-wide `reports:write` holder's mutation routes.
 *
 * Each of those four routes is a different kind of wrong:
 *
 *  - `PUT /:id` / `DELETE /:id` — edits or destroys a definition the scheduler
 *    will simply recreate on the next occurrence, silently orphaning nothing
 *    and confusing everyone.
 *  - `POST /:id/generate` — a system definition has no acting user to execute
 *    as, and its type has no generator at all (the artifact is stored, not
 *    produced).
 *  - `POST /:id/reauthorize` — the worst of the four: it rewrites the stored
 *    provenance through `persistedSiteScopeValues`, which always stamps
 *    `principal_kind: 'user'`. One call and the definition stops being
 *    system-managed, defeating the `reportScheduleWorker` guard that keeps the
 *    scheduled-report worker from ever executing it.
 *
 * Reads and downloads stay open — that contract is pinned separately by
 * `runs.systemPrincipal.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const ORG_ID = '22222222-2222-4222-8222-222222222222';
const REPORT_ID = '44444444-4444-4444-8444-444444444444';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const CAPTURED_AT = new Date('2026-07-25T12:34:56.000Z');

const state = vi.hoisted(() => ({
  authority: null as unknown,
  rows: [] as Array<Record<string, unknown>>,
  selects: 0,
  writes: 0,
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (c: any, next: () => Promise<void>) => {
    c.set('auth', {
      user: { id: USER_ID, email: 'admin@example.com' },
      scope: 'organization',
      orgId: ORG_ID,
      partnerId: null,
      accessibleOrgIds: [ORG_ID],
      canAccessOrg: (orgId: string) => orgId === ORG_ID,
    });
    await next();
  },
  requireScope: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requirePermission: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

vi.mock('../../db', () => {
  const select = vi.fn((projection?: Record<string, unknown>) => {
    state.selects += 1;
    const source = state.rows.shift() ?? {};
    // Project the fixture row through the requested keys ONLY, so a column a
    // route forgot to select is genuinely absent — same idiom as
    // runs.systemPrincipal.test.ts.
    const row = projection
      ? Object.fromEntries(Object.keys(projection).map((key) => [key, source[key]]))
      : source;
    // The chain is itself thenable and EVERY builder method returns it, so
    // `.limit(1).for('update')` (loadLockedDefinition) works as well as a bare
    // `.where(...)` await (the list route).
    const chain: Record<string, unknown> = {
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve([row]).then(resolve, reject),
    };
    for (const method of ['from', 'innerJoin', 'where', 'orderBy', 'offset', 'limit', 'for']) {
      chain[method] = vi.fn(() => chain);
    }
    return chain;
  });

  const writeChain = () => {
    state.writes += 1;
    const chain: Record<string, unknown> = {};
    for (const method of ['set', 'values', 'where']) {
      chain[method] = vi.fn(() => chain);
    }
    chain.returning = vi.fn(() => Promise.resolve([{ id: REPORT_ID, orgId: ORG_ID, name: 'x' }]));
    return chain;
  };

  const handle = {
    select,
    insert: vi.fn(() => writeChain()),
    update: vi.fn(() => writeChain()),
    delete: vi.fn(() => writeChain()),
  };

  return {
    db: {
      ...handle,
      transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(handle)),
    },
    runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
    withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => fn()),
  };
});

vi.mock('../../services/reportGenerationService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/reportGenerationService')>();
  return {
    ...actual,
    generateReport: vi.fn(),
    previousBaselineFor: vi.fn(async () => undefined),
    assertReportExecutionPreflight: vi.fn(),
  };
});

vi.mock('../../services/sensitiveReadAudit', () => ({ auditSensitiveRead: vi.fn() }));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));

// Real site-scope algebra; only the live-authority DB lookup is replaced —
// the decode of a system-principal row is exactly what must keep working.
vi.mock('../../services/siteScope', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/siteScope')>();
  return {
    ...actual,
    resolveRequestReportAuthority: vi.fn(async () => state.authority),
    resolveRequestReportAuthorityMap: vi.fn(async () => new Map()),
  };
});

import { coreRoutes } from './core';
import { runsRoutes } from './runs';
import { generateRoutes } from './generate';
import { siteScopeFingerprint } from '../../services/siteScope';
import { generateReport } from '../../services/reportGenerationService';

function app(): Hono {
  const instance = new Hono();
  instance.route('/reports', coreRoutes);
  instance.route('/reports', runsRoutes);
  instance.route('/reports', generateRoutes);
  return instance;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

function unrestrictedAuthority() {
  const scope = { version: 1 as const, kind: 'unrestricted' as const, orgId: ORG_ID };
  return {
    ok: true,
    authority: {
      principalKind: 'user',
      scope,
      principalUserId: USER_ID,
      capturedAt: CAPTURED_AT,
      fingerprint: siteScopeFingerprint(scope),
    },
  };
}

/** The definition `persistNarrativeReport` writes. */
function systemDefinition(overrides: Record<string, unknown> = {}) {
  return {
    id: REPORT_ID,
    orgId: ORG_ID,
    name: 'Weekly AI operations narrative',
    type: 'ai_org_narrative',
    config: {},
    schedule: 'weekly',
    format: 'pdf',
    createdBy: null,
    executionScopeVersion: 1,
    executionScopeKind: 'unrestricted',
    executionScopeSiteIds: null,
    executionScopeUserId: null,
    executionScopeFingerprint: siteScopeFingerprint({
      version: 1, kind: 'unrestricted', orgId: ORG_ID,
    }),
    executionScopeCapturedAt: CAPTURED_AT,
    executionScopePrincipalKind: 'system',
    sourceAiAgentScheduleId: '55555555-5555-4555-8555-555555555555',
    ...overrides,
  };
}

/** An ordinary user-owned definition — the positive control for every case
 *  below: without it, a route that 409s unconditionally would look correct. */
function userDefinition(overrides: Record<string, unknown> = {}) {
  return systemDefinition({
    type: 'device_inventory',
    name: 'Device inventory',
    createdBy: USER_ID,
    executionScopeUserId: USER_ID,
    executionScopePrincipalKind: 'user',
    sourceAiAgentScheduleId: null,
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  state.rows = [];
  state.selects = 0;
  state.writes = 0;
  state.authority = unrestrictedAuthority();
});

describe('system-managed report definitions are read-only', () => {
  it('refuses PUT /:id with 409 system_managed_report, writing nothing', async () => {
    state.rows = [systemDefinition(), systemDefinition()];

    const res = await app().request(`/reports/${REPORT_ID}`, {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: 'Renamed by a technician' }),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'system_managed_report' });
    expect(state.writes).toBe(0);
  });

  it('CONTROL: PUT /:id still updates an ordinary user-owned definition', async () => {
    state.rows = [userDefinition(), userDefinition()];

    const res = await app().request(`/reports/${REPORT_ID}`, {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: 'Renamed by a technician' }),
    });

    expect(res.status).toBe(200);
    expect(state.writes).toBeGreaterThan(0);
  });

  it('refuses DELETE /:id with 409 system_managed_report, deleting nothing', async () => {
    state.rows = [systemDefinition(), systemDefinition()];

    const res = await app().request(`/reports/${REPORT_ID}`, { method: 'DELETE' });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'system_managed_report' });
    expect(state.writes).toBe(0);
  });

  it('CONTROL: DELETE /:id still removes an ordinary user-owned definition', async () => {
    state.rows = [userDefinition(), userDefinition()];

    const res = await app().request(`/reports/${REPORT_ID}`, { method: 'DELETE' });

    expect(res.status).toBe(200);
    expect(state.writes).toBeGreaterThan(0);
  });

  /**
   * The one that matters most: `persistedSiteScopeValues` unconditionally
   * stamps `principal_kind: 'user'`, so a successful reauthorize would convert
   * a system definition into a user one — and the scheduled-report worker's
   * `executionScopePrincipalKind === 'system'` refusal would stop firing.
   */
  it('refuses POST /:id/reauthorize with 409, so the system principal can never be rewritten to `user`', async () => {
    state.rows = [systemDefinition(), systemDefinition()];

    const res = await app().request(`/reports/${REPORT_ID}/reauthorize`, { method: 'POST' });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'system_managed_report' });
    expect(state.writes).toBe(0);
  });

  it('CONTROL: POST /:id/reauthorize still restamps an ordinary user-owned definition', async () => {
    state.rows = [userDefinition(), userDefinition()];

    const res = await app().request(`/reports/${REPORT_ID}/reauthorize`, { method: 'POST' });

    expect(res.status).toBe(200);
    expect(state.writes).toBeGreaterThan(0);
  });

  it('refuses POST /:id/generate with 409, never reaching the generator', async () => {
    state.rows = [systemDefinition(), systemDefinition()];

    const res = await app().request(`/reports/${REPORT_ID}/generate`, { method: 'POST' });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'system_managed_report' });
    expect(generateReport).not.toHaveBeenCalled();
    expect(state.writes).toBe(0);
  });

  /**
   * The second signal of `isSystemManagedReportDefinition`'s OR, on its own: a
   * definition whose principal has been rewritten to 'user' (a legacy row, or
   * the exact damage the reauthorize route above would have done before it was
   * gated) is STILL a narrative nobody can regenerate. Without the `type` leg
   * this row would fall through to the generator and 500.
   */
  it('refuses a narrative-TYPE definition even when its principal is no longer `system`', async () => {
    const forged = systemDefinition({
      executionScopePrincipalKind: 'user',
      executionScopeUserId: USER_ID,
    });
    state.rows = [forged, forged];

    const res = await app().request(`/reports/${REPORT_ID}/generate`, { method: 'POST' });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'system_managed_report' });
    expect(generateReport).not.toHaveBeenCalled();
  });

  /**
   * And the FIRST signal on its own: an ordinary type whose principal is
   * 'system'. There is no such definition today, but the gate must not depend
   * on the narrative type to fire — a system-principal row has no acting user
   * to execute as whatever its type says.
   */
  it('refuses a system-principal definition of an ordinary type', async () => {
    const row = systemDefinition({ type: 'device_inventory' });
    state.rows = [row, row];

    const res = await app().request(`/reports/${REPORT_ID}/generate`, { method: 'POST' });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'system_managed_report' });
  });
});

describe('the narrative type is not creatable or generatable on demand', () => {
  it('rejects POST /reports with the internal type', async () => {
    const res = await app().request('/reports', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: 'Mine now', type: 'ai_org_narrative' }),
    });

    expect(res.status).toBe(400);
    expect(String((await res.json()).error)).toContain('internal report type');
    expect(state.writes).toBe(0);
  });

  it('CONTROL: POST /reports still creates an ordinary type', async () => {
    state.rows = [userDefinition()];

    const res = await app().request('/reports', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: 'Device inventory', type: 'device_inventory' }),
    });

    expect(res.status).toBe(201);
  });

  it('rejects the ad-hoc POST /reports/generate with the internal type', async () => {
    const res = await app().request('/reports/generate', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ type: 'ai_org_narrative' }),
    });

    expect(res.status).toBe(400);
    expect(String((await res.json()).error)).toContain('internal report type');
    expect(generateReport).not.toHaveBeenCalled();
  });

  it('still accepts the internal type as a LIST filter — reads stay open', async () => {
    state.rows = [systemDefinition()];

    const res = await app().request('/reports?type=ai_org_narrative');

    expect(res.status).toBe(200);
  });
});
