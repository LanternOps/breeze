import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

/**
 * Regression suite for the CROSS-TENANT CIS SCAN FAN-OUT (security review 2026-08-16 §1.2).
 *
 * Before the fix, every device authorization predicate on `POST /cis/scan` lived
 * inside `if (Array.isArray(body.deviceIds) && body.deviceIds.length > 0)`. Omitting
 * `deviceIds` skipped ALL of them and handed `deviceIds: undefined` to
 * `scheduleCisScan`, which labels the job `'all'` and lets the worker resolve devices
 * through the baseline's PARTNER — so an organization-scope caller could fan a scan
 * across every customer org under the MSP.
 *
 * These tests are deliberately BEHAVIOURAL rather than "was some where() built":
 * the db mock below actually EVALUATES the drizzle condition tree against a fixture
 * device table (the schema mock makes every column a plain string, so drizzle keeps
 * both sides of each comparison as raw query chunks — see `evalCondition`). If the
 * route stops applying `auth.orgCondition`, or stops resolving the set server-side,
 * the fixture rows that come back change and the assertions fail.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const PARTNER_ID = 'partner-1';
const BASELINE_ID = '11111111-1111-1111-1111-111111111111';

type OrgRow = { id: string; partnerId: string };
type DeviceRow = {
  id: string;
  orgId: string;
  osType: string;
  isEphemeral: boolean;
  status: string;
  siteId: string | null;
};

const ORGS: OrgRow[] = [
  { id: 'org-a', partnerId: PARTNER_ID },
  { id: 'org-b', partnerId: PARTNER_ID },
  { id: 'org-c', partnerId: 'partner-2' },
];

const DEVICES: DeviceRow[] = [
  // org-a — the caller's own org
  { id: 'dev-a1', orgId: 'org-a', osType: 'windows', isEphemeral: false, status: 'online', siteId: 'site-a' },
  { id: 'dev-a2', orgId: 'org-a', osType: 'linux', isEphemeral: false, status: 'online', siteId: 'site-a' },
  { id: 'dev-a3', orgId: 'org-a', osType: 'windows', isEphemeral: true, status: 'online', siteId: 'site-a' },
  { id: 'dev-a4', orgId: 'org-a', osType: 'windows', isEphemeral: false, status: 'decommissioned', siteId: 'site-a' },
  // org-b — a DIFFERENT customer under the SAME partner. This is the blast radius.
  { id: 'dev-b1', orgId: 'org-b', osType: 'windows', isEphemeral: false, status: 'online', siteId: 'site-b' },
  // org-c — a different partner entirely
  { id: 'dev-c1', orgId: 'org-c', osType: 'windows', isEphemeral: false, status: 'online', siteId: 'site-c' },
];

const { state } = vi.hoisted(() => ({
  state: {
    orgs: [] as Array<Record<string, unknown>>,
    devices: [] as Array<Record<string, unknown>>,
    baselines: [] as Array<Record<string, unknown>>,
    auth: {} as Record<string, unknown>,
    permissions: undefined as unknown,
  },
}));

// ---------------------------------------------------------------------------
// db mock: a tiny evaluator over drizzle's queryChunks.
//
// With the schema mocked to plain strings, `eq(devices.orgId, 'org-a')` serializes
// to the chunk sequence [StringChunk(''), 'devices.orgId', StringChunk(' = '),
// 'org-a', StringChunk('')] — both operands survive as raw chunks. That lets the
// mock behave like a real filter instead of rubber-stamping whatever SQL it is
// handed, so an assertion here cannot pass with the guard removed.
// ---------------------------------------------------------------------------
vi.mock('../db', () => {
  function isSql(node: unknown): node is { queryChunks: unknown[] } {
    return !!node && Array.isArray((node as { queryChunks?: unknown[] }).queryChunks);
  }
  function stringChunk(node: unknown): string | null {
    const value = (node as { value?: unknown })?.value;
    return Array.isArray(value) && value.every((v) => typeof v === 'string') ? value.join('') : null;
  }

  type SubqueryChain = { __table: string; __where: unknown };
  function isSubquery(node: unknown): node is SubqueryChain {
    return !!node && typeof (node as SubqueryChain).__table === 'string';
  }

  function subqueryIds(chain: SubqueryChain): unknown[] {
    if (chain.__table !== 'organizations') throw new Error(`unexpected subquery on ${chain.__table}`);
    return state.orgs.filter((row) => evalCondition(chain.__where, row)).map((row) => row.id);
  }

  function evalCondition(cond: unknown, row: Record<string, unknown>): boolean {
    if (cond === undefined || cond === null) return true;
    if (!isSql(cond)) throw new Error('condition is not a drizzle SQL node');

    const raws: unknown[] = [];
    const nested: unknown[] = [];
    const strings: string[] = [];
    for (const chunk of cond.queryChunks) {
      if (isSql(chunk)) {
        nested.push(chunk);
        continue;
      }
      const s = stringChunk(chunk);
      if (s !== null) strings.push(s);
      else raws.push(chunk);
    }

    // Composite / wrapper node (and(), or(), and the paren wrapper they emit).
    if (raws.length === 0) {
      if (nested.length === 0) throw new Error('empty condition node');
      const results = nested.map((n) => evalCondition(n, row));
      return strings.includes(' or ') ? results.some(Boolean) : results.every(Boolean);
    }

    // Leaf comparison: raws[0] is the column, the rest are operands.
    const column = String(raws[0]);
    // `inArray(col, [a, b])` binds the whole array as ONE chunk, so flatten it.
    const operands = raws.slice(1).flatMap((v) => (Array.isArray(v) ? v : [v]));
    const op = (strings.find((s) => s.trim().length > 0) ?? '=').trim();
    const cell = row[column.includes('.') ? column.slice(column.indexOf('.') + 1) : column];

    if (op === '=') return cell === operands[0];
    if (op === '<>') return cell !== operands[0];
    if (op === 'in') {
      if (operands.length === 1 && isSubquery(operands[0])) {
        return subqueryIds(operands[0] as SubqueryChain).includes(cell);
      }
      return operands.includes(cell);
    }
    throw new Error(`unsupported operator '${op}'`);
  }

  function makeSelect(columns?: Record<string, unknown>) {
    const chain: Record<string, unknown> = {
      __table: 'unknown',
      __where: undefined,
      __columns: columns,
      from(table: unknown) {
        chain.__table = (table as { __t?: string })?.__t ?? 'unknown';
        return chain;
      },
      where(w: unknown) {
        chain.__where = w;
        return chain;
      },
      limit(_n: number) {
        return Promise.resolve(rows());
      },
      then(onOk: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) {
        return Promise.resolve(rows()).then(onOk, onErr);
      },
    };
    function rows(): unknown[] {
      if (chain.__table === 'cis_baselines') return state.baselines;
      if (chain.__table === 'organizations') {
        return state.orgs.filter((r) => evalCondition(chain.__where, r));
      }
      if (chain.__table === 'devices') {
        return state.devices
          .filter((r) => evalCondition(chain.__where, r))
          .map((r) => ({ id: r.id, siteId: r.siteId }));
      }
      return [];
    }
    return chain;
  }

  return {
    runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
    withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    db: {
      select: vi.fn((columns?: Record<string, unknown>) => makeSelect(columns)),
      insert: vi.fn(),
      update: vi.fn(),
    },
  };
});

vi.mock('../db/schema', () => ({
  cisBaselines: {
    __t: 'cis_baselines',
    id: 'cisBaselines.id',
    orgId: 'cisBaselines.orgId',
    partnerId: 'cisBaselines.partnerId',
    osType: 'cisBaselines.osType',
    isActive: 'cisBaselines.isActive',
    updatedAt: 'cisBaselines.updatedAt',
  },
  cisBaselineResults: { __t: 'cis_baseline_results', id: 'cisBaselineResults.id', orgId: 'cisBaselineResults.orgId' },
  cisRemediationActions: { __t: 'cis_remediation_actions', id: 'cisRemediationActions.id' },
  devices: {
    __t: 'devices',
    id: 'devices.id',
    orgId: 'devices.orgId',
    osType: 'devices.osType',
    siteId: 'devices.siteId',
    isEphemeral: 'devices.isEphemeral',
    status: 'devices.status',
    hostname: 'devices.hostname',
  },
  organizations: {
    __t: 'organizations',
    id: 'organizations.id',
    partnerId: 'organizations.partnerId',
  },
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', state.auth);
    c.set('permissions', state.permissions);
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (c: any, next: any) => {
    c.set('permissions', state.permissions);
    return next();
  }),
}));

vi.mock('../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../services/cisHardening', () => ({
  extractFailedCheckIds: vi.fn(),
  normalizeCisSchedule: vi.fn((s: any) => s ?? null),
}));
vi.mock('../jobs/cisJobs', () => ({
  scheduleCisScan: vi.fn(),
  scheduleCisRemediation: vi.fn(),
  scheduleCisRemediationWithResult: vi.fn(),
}));
vi.mock('./networkShared', () => ({
  resolveOrgId: vi.fn((auth: any, requestedOrgId?: string) => {
    if (auth.scope === 'organization') return { orgId: auth.orgId };
    if (requestedOrgId) return { orgId: requestedOrgId };
    return { error: 'orgId is required', status: 400 };
  }),
}));

import { eq, inArray } from 'drizzle-orm';
import { cisHardeningRoutes } from './cisHardening';
import { devices } from '../db/schema';
import { scheduleCisScan } from '../jobs/cisJobs';

function makeAuth(scope: 'organization' | 'partner' | 'system', accessibleOrgIds: string[] | null) {
  return {
    user: { id: 'user-1', email: 'tech@msp.example', name: 'Tech' },
    scope,
    partnerId: PARTNER_ID,
    orgId: accessibleOrgIds?.[0] ?? null,
    accessibleOrgIds,
    // Mirrors buildOrgAccessClosures (middleware/auth.ts): null = unrestricted.
    orgCondition: (column: any) => {
      if (accessibleOrgIds === null) return undefined;
      if (accessibleOrgIds.length === 1) return eq(column, accessibleOrgIds[0]);
      return inArray(column, accessibleOrgIds);
    },
    canAccessOrg: (orgId: string) => accessibleOrgIds === null || accessibleOrgIds.includes(orgId),
  };
}

function partnerWideBaseline(overrides: Record<string, unknown> = {}) {
  return {
    id: BASELINE_ID,
    orgId: null,
    partnerId: PARTNER_ID,
    name: 'Windows L1 (all orgs)',
    osType: 'windows',
    benchmarkVersion: '3.0.0',
    level: 'l1',
    customExclusions: [],
    scanSchedule: null,
    isActive: true,
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function scan(app: Hono, body: Record<string, unknown>) {
  return app.request('/cis/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
    body: JSON.stringify(body),
  });
}

function scheduledDeviceIds(): string[] | undefined {
  expect(scheduleCisScan).toHaveBeenCalledTimes(1);
  const [, options] = vi.mocked(scheduleCisScan).mock.calls[0]! as [string, { deviceIds?: string[] }];
  return options.deviceIds;
}

describe('POST /cis/scan — target-set authorization (security review §1.2)', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    state.orgs = ORGS.map((o) => ({ ...o }));
    state.devices = DEVICES.map((d) => ({ ...d }));
    state.baselines = [partnerWideBaseline()];
    state.permissions = undefined;
    state.auth = makeAuth('organization', ['org-a']);
    vi.mocked(scheduleCisScan).mockResolvedValue('job-1');
    app = new Hono();
    app.route('/cis', cisHardeningRoutes);
  });

  it('an ORG-scope caller omitting deviceIds on a PARTNER-WIDE baseline targets ONLY their own org', async () => {
    const res = await scan(app, { baselineId: BASELINE_ID });
    expect(res.status).toBe(202);

    const targeted = scheduledDeviceIds();
    // The whole point: an explicit, server-authorized list — never `undefined`,
    // which is what made the worker fan out through the partner.
    expect(Array.isArray(targeted)).toBe(true);
    expect(targeted).toEqual(['dev-a1']);
    // The other customer under the SAME partner must not be touched.
    expect(targeted).not.toContain('dev-b1');
    // Nor another partner's fleet, nor OS mismatches / ephemeral / decommissioned.
    expect(targeted).not.toContain('dev-c1');
    expect(targeted).not.toContain('dev-a2');
    expect(targeted).not.toContain('dev-a3');
    expect(targeted).not.toContain('dev-a4');
  });

  it('builds the target set with auth.orgCondition on devices.orgId', async () => {
    const orgConditionSpy = vi.fn((column: any) => eq(column, 'org-a'));
    state.auth = { ...makeAuth('organization', ['org-a']), orgCondition: orgConditionSpy };

    const res = await scan(app, { baselineId: BASELINE_ID });

    expect(res.status).toBe(202);
    expect(orgConditionSpy).toHaveBeenCalledWith(devices.orgId);
  });

  it('a PARTNER-scope caller omitting deviceIds fans out across the orgs they can access', async () => {
    state.auth = makeAuth('partner', ['org-a', 'org-b']);

    const res = await scan(app, { baselineId: BASELINE_ID });

    expect(res.status).toBe(202);
    expect(scheduledDeviceIds()!.sort()).toEqual(['dev-a1', 'dev-b1']);
  });

  it('a SYSTEM-scope caller (no org filter) still stops at the baseline owner partner', async () => {
    state.auth = makeAuth('system', null);

    const res = await scan(app, { baselineId: BASELINE_ID });

    expect(res.status).toBe(202);
    const targeted = scheduledDeviceIds()!.sort();
    expect(targeted).toEqual(['dev-a1', 'dev-b1']);
    expect(targeted).not.toContain('dev-c1');
  });

  it('drops site-restricted devices from a server-resolved set instead of 403-ing the whole scan', async () => {
    state.auth = makeAuth('partner', ['org-a', 'org-b']);
    state.permissions = { allowedSiteIds: ['site-a'] };

    const res = await scan(app, { baselineId: BASELINE_ID });

    expect(res.status).toBe(202);
    expect(scheduledDeviceIds()).toEqual(['dev-a1']);
  });

  it('queues nothing when the authorized target set is empty', async () => {
    state.auth = makeAuth('organization', ['org-c']); // org-c is under a different partner

    const res = await scan(app, { baselineId: BASELINE_ID });

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.jobId).toBeNull();
    expect(body.deviceCount).toBe(0);
    expect(scheduleCisScan).not.toHaveBeenCalled();
  });

  // The route schema requires GUIDs, so the explicit-list cases use GUID fixtures.
  const GUID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const GUID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  it('still 400s an EXPLICIT deviceIds list that reaches into another org', async () => {
    // The caller is org-a scoped; GUID_B lives in org-b, so it never resolves.
    state.devices = [
      { id: GUID_A, orgId: 'org-a', osType: 'windows', isEphemeral: false, status: 'online', siteId: 'site-a' },
      { id: GUID_B, orgId: 'org-b', osType: 'windows', isEphemeral: false, status: 'online', siteId: 'site-b' },
    ];

    const res = await scan(app, { baselineId: BASELINE_ID, deviceIds: [GUID_A, GUID_B] });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('do not belong');
    expect(scheduleCisScan).not.toHaveBeenCalled();
  });

  it('still 403s an EXPLICIT deviceIds list that reaches outside the caller allowed sites', async () => {
    state.auth = makeAuth('partner', ['org-a', 'org-b']);
    state.permissions = { allowedSiteIds: ['site-a'] };
    state.devices = [
      { id: GUID_A, orgId: 'org-a', osType: 'windows', isEphemeral: false, status: 'online', siteId: 'site-a' },
      { id: GUID_B, orgId: 'org-b', osType: 'windows', isEphemeral: false, status: 'online', siteId: 'site-b' },
    ];

    const res = await scan(app, { baselineId: BASELINE_ID, deviceIds: [GUID_A, GUID_B] });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.deniedDeviceIds).toEqual([GUID_B]);
    expect(scheduleCisScan).not.toHaveBeenCalled();
  });
});
