import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { UserPermissions } from '../../services/permissions';

/**
 * Route tests for `aiDataPolicyRoutes` (#8852 W1): the org override half of
 * `ai_data_policies`. requirePermission/requireScope/requireMfa stay REAL;
 * DB, policy resolvers, audit sink, auth identity and permission lookup are
 * mocked (same harness as scriptPolicy.test.ts).
 */

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '99999999-9999-4999-8999-999999999999';
const PARTNER = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';

type SelectRow = Record<string, unknown>;
let selectQueue: SelectRow[][] = [];
let writes: Array<{ values: Record<string, unknown>; set: Record<string, unknown>; target: unknown }> = [];
const executeMock = vi.fn();

vi.mock('../../db', () => ({
  db: {
    // The preview's bounded count (countTranscriptPreview, kept REAL).
    execute: (...a: unknown[]) => executeMock(...a),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => selectQueue.shift() ?? []),
        })),
      })),
    })),
    insert: vi.fn(() => {
      let insertedValues: Record<string, unknown> = {};
      return {
        values: vi.fn((v: Record<string, unknown>) => {
          insertedValues = v;
          return {
            onConflictDoUpdate: vi.fn((opts: { target: unknown; set: Record<string, unknown> }) => {
              writes.push({ values: insertedValues, set: opts.set, target: opts.target });
              return {
                returning: vi.fn(async () => [{ id: 'row-1', ...insertedValues, ...opts.set }]),
              };
            }),
          };
        }),
      };
    }),
  },
}));

const resolveAiDataPolicy = vi.fn();
const resolveAiDataPolicyCeiling = vi.fn();
vi.mock('../../services/aiDataPolicy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/aiDataPolicy')>();
  return {
    ...actual,
    resolveAiDataPolicy: (...a: unknown[]) => resolveAiDataPolicy(...a),
    resolveAiDataPolicyCeiling: (...a: unknown[]) => resolveAiDataPolicyCeiling(...a),
    // The GET reads both from one partner-row read; route it through the two
    // spies so each test keeps asserting on the value it scripts.
    resolveAiDataPolicyWithCeiling: async (orgId: string) => ({
      effective: await resolveAiDataPolicy(orgId),
      ceiling: await resolveAiDataPolicyCeiling(orgId),
    }),
  };
});

const auditLog: Array<Record<string, unknown>> = [];
vi.mock('../../services/auditService', () => ({
  createAuditLogAsync: vi.fn(async (params: Record<string, unknown>) => {
    auditLog.push(params);
  }),
}));

let currentAuth: Record<string, unknown> = {};
vi.mock('../../middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../middleware/auth')>();
  return {
    ...actual,
    authMiddleware: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('auth', currentAuth);
      await next();
    },
  };
});

let currentPerms: UserPermissions | null = null;
vi.mock('../../services/permissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/permissions')>();
  return { ...actual, getUserPermissions: vi.fn(async () => currentPerms) };
});

import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { PERMISSIONS } from '../../services/permissions';
import { aiDataPolicies } from '../../db/schema';
import { aiDataPolicyRoutes } from './dataPolicy';

function orgAuth(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    user: { id: USER_ID, email: 'tech@example.com' },
    scope: 'organization',
    orgId: ORG_A,
    partnerId: PARTNER,
    accessibleOrgIds: [ORG_A],
    token: { mfa: true, sid: 'sid-1' },
    canAccessOrg: (id: string) => id === ORG_A,
    partnerOrgAccess: 'all',
    ...overrides,
  };
}

function partnerAuth(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    user: { id: USER_ID, email: 'partner-admin@example.com' },
    scope: 'partner',
    orgId: null,
    partnerId: PARTNER,
    partnerOrgAccess: 'all',
    accessibleOrgIds: [ORG_A],
    token: { mfa: true, sid: 'sid-1' },
    canAccessOrg: (id: string) => id === ORG_A,
    ...overrides,
  };
}

const ALL_GRANTS = [PERMISSIONS.AI_AGENTS_READ, PERMISSIONS.AI_AGENTS_WRITE];
function makePerms(grants: Array<{ resource: string; action: string }>): UserPermissions {
  return { permissions: grants, partnerId: null, orgId: ORG_A, roleId: 'role-1', scope: 'organization' };
}

const SRC = { deviceFileReadLevel: 'default', toolOutputRetentionDays: 'default', transcriptRetentionDays: 'default' } as const;
const CEILING = { deviceFileReadLevel: 'no_user_profiles', toolOutputRetentionDays: 30, transcriptRetentionDays: 365, source: SRC };
const mockCeiling = (c: { deviceFileReadLevel: string; toolOutputRetentionDays: number | null; transcriptRetentionDays?: number | null }) =>
  resolveAiDataPolicyCeiling.mockResolvedValue({ transcriptRetentionDays: 365, ...c, source: SRC });

beforeEach(() => {
  vi.clearAllMocks();
  selectQueue = [];
  writes = [];
  auditLog.length = 0;
  executeMock.mockReset();
  currentAuth = orgAuth();
  currentPerms = makePerms(ALL_GRANTS);
  resolveAiDataPolicy.mockResolvedValue(CEILING);
  resolveAiDataPolicyCeiling.mockResolvedValue(CEILING);
});

const URL_A = `/data-policy?orgId=${ORG_A}`;
const getReq = (url = '/data-policy') => aiDataPolicyRoutes.request(url);
const putReq = (body: unknown, url = URL_A) =>
  aiDataPolicyRoutes.request(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('GET /data-policy', () => {
  it('returns policy, effective and ceiling for an org token', async () => {
    const row = {
      id: 'p1', orgId: ORG_A, partnerId: null, deviceFileReadLevel: 'off', toolOutputRetentionDays: 7, transcriptRetentionDays: 60,
      createdBy: USER_ID, createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-02T00:00:00Z'),
    };
    selectQueue = [[row]];
    const effective = {
      deviceFileReadLevel: 'off', toolOutputRetentionDays: 7, transcriptRetentionDays: 60,
      source: { deviceFileReadLevel: 'org', toolOutputRetentionDays: 'org', transcriptRetentionDays: 'org' },
    };
    resolveAiDataPolicy.mockResolvedValue(effective);
    const res = await getReq();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      policy: {
        id: 'p1', orgId: ORG_A, partnerId: null, deviceFileReadLevel: 'off', toolOutputRetentionDays: 7, transcriptRetentionDays: 60,
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
      effective,
      ceiling: CEILING,
    });
    expect(resolveAiDataPolicy).toHaveBeenCalledWith(ORG_A);
    expect(resolveAiDataPolicyCeiling).toHaveBeenCalledWith(ORG_A);
  });

  it('returns policy:null when the org has no row', async () => {
    selectQueue = [[]];
    const body = await (await getReq()).json();
    expect(body.policy).toBeNull();
    expect(body.effective).toEqual(CEILING);
  });

  it('partner token targets the ?orgId= org', async () => {
    currentAuth = partnerAuth();
    selectQueue = [[]];
    expect((await getReq(`/data-policy?orgId=${ORG_A}`)).status).toBe(200);
    expect(resolveAiDataPolicy).toHaveBeenCalledWith(ORG_A);
  });

  it('400s for a partner token without orgId', async () => {
    currentAuth = partnerAuth();
    const res = await getReq('/data-policy');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'orgId is required' });
    expect(resolveAiDataPolicy).not.toHaveBeenCalled();
  });

  it('403s for an org the caller cannot access (not a 400: the request is well-formed)', async () => {
    currentAuth = partnerAuth();
    const res = await getReq(`/data-policy?orgId=${ORG_B}`);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Access to this organization denied.' });
    expect(resolveAiDataPolicy).not.toHaveBeenCalled();
    expect(resolveAiDataPolicyCeiling).not.toHaveBeenCalled();
  });

  it('403s without ai_agents:read', async () => {
    currentPerms = makePerms([]);
    expect((await getReq()).status).toBe(403);
  });
});

describe('PUT /data-policy', () => {
  it('rejects an org level looser than the partner ceiling with 422', async () => {
    mockCeiling({ deviceFileReadLevel: 'no_user_profiles', toolOutputRetentionDays: 30 });
    const res = await putReq({ deviceFileReadLevel: 'any_with_approval' });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'above_partner_ceiling', field: 'deviceFileReadLevel' });
    expect(writes).toHaveLength(0);
    expect(auditLog).toHaveLength(0);
  });

  it('rejects retention longer than the partner ceiling with 422', async () => {
    mockCeiling({ deviceFileReadLevel: 'no_user_profiles', toolOutputRetentionDays: 30 });
    const res = await putReq({ toolOutputRetentionDays: 60 });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'above_partner_ceiling', field: 'toolOutputRetentionDays' });
    expect(writes).toHaveLength(0);
  });

  it('rejects a transcript window longer than the partner ceiling with 422 naming the field', async () => {
    mockCeiling({ deviceFileReadLevel: 'no_user_profiles', toolOutputRetentionDays: 30, transcriptRetentionDays: 180 });
    const res = await putReq({ transcriptRetentionDays: 181 });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'above_partner_ceiling', field: 'transcriptRetentionDays' });
    expect(writes).toHaveLength(0);
    expect(auditLog).toHaveLength(0);
  });

  it('accepts a transcript window at or under the ceiling, and any window when the ceiling is forever', async () => {
    mockCeiling({ deviceFileReadLevel: 'no_user_profiles', toolOutputRetentionDays: 30, transcriptRetentionDays: 180 });
    expect((await putReq({ transcriptRetentionDays: 180 })).status).toBe(200);
    expect(writes[0]!.values).toMatchObject({ orgId: ORG_A, transcriptRetentionDays: 180 });
    mockCeiling({ deviceFileReadLevel: 'no_user_profiles', toolOutputRetentionDays: 30, transcriptRetentionDays: null });
    expect((await putReq({ transcriptRetentionDays: 3650 })).status).toBe(200);
  });

  it('null clears the org transcript window (inherit) in insert and conflict set', async () => {
    mockCeiling({ deviceFileReadLevel: 'no_user_profiles', toolOutputRetentionDays: 30, transcriptRetentionDays: 30 });
    const res = await putReq({ transcriptRetentionDays: null });
    expect(res.status).toBe(200);
    expect(writes[0]!.values.transcriptRetentionDays).toBeNull();
    expect(writes[0]!.set.transcriptRetentionDays).toBeNull();
    expect((await res.json()).policy.transcriptRetentionDays).toBeNull();
  });

  it('allows any retention when the ceiling is keep-forever (null)', async () => {
    mockCeiling({ deviceFileReadLevel: 'no_user_profiles', toolOutputRetentionDays: null });
    expect((await putReq({ toolOutputRetentionDays: 3650 })).status).toBe(200);
  });

  it('accepts a level equal to the ceiling and retention equal to the ceiling', async () => {
    mockCeiling({ deviceFileReadLevel: 'no_user_profiles', toolOutputRetentionDays: 30 });
    expect((await putReq({ deviceFileReadLevel: 'no_user_profiles', toolOutputRetentionDays: 30 })).status).toBe(200);
  });

  it('accepts a tighter level, upserts on org_id and writes an audit row', async () => {
    mockCeiling({ deviceFileReadLevel: 'no_user_profiles', toolOutputRetentionDays: 30 });
    const res = await putReq({ deviceFileReadLevel: 'off', toolOutputRetentionDays: 7 });
    expect(res.status).toBe(200);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.target).toBe(aiDataPolicies.orgId);
    expect(writes[0]!.values).toEqual({
      orgId: ORG_A, partnerId: null, createdBy: USER_ID, deviceFileReadLevel: 'off', toolOutputRetentionDays: 7,
    });
    expect(writes[0]!.set).toMatchObject({ deviceFileReadLevel: 'off', toolOutputRetentionDays: 7 });
    expect(writes[0]!.set.updatedAt).toBeInstanceOf(Date);
    expect((await res.json()).policy).toMatchObject({ id: 'row-1', orgId: ORG_A, partnerId: null, deviceFileReadLevel: 'off', toolOutputRetentionDays: 7 });
    expect(resolveAiDataPolicyCeiling).toHaveBeenCalledWith(ORG_A);
    expect(auditLog).toHaveLength(1);
    expect(auditLog[0]).toMatchObject({
      orgId: ORG_A,
      actorType: 'user',
      actorId: USER_ID,
      actorEmail: 'tech@example.com',
      action: 'ai.data_policy.updated',
      resourceType: 'ai_data_policies',
      resourceId: 'row-1',
      details: { level: 'org', deviceFileReadLevel: 'off', toolOutputRetentionDays: 7 },
      result: 'success',
    });
    expect(auditLog[0]!.partnerId).toBeUndefined();
  });

  it('null clears an org field back to inherit without a ceiling violation', async () => {
    const res = await putReq({ deviceFileReadLevel: null, toolOutputRetentionDays: null });
    expect(res.status).toBe(200);
    expect(writes[0]!.set).toMatchObject({ deviceFileReadLevel: null, toolOutputRetentionDays: null });
  });

  // W01 review follow-up (#8854): an org token's own org is the only target;
  // a ?orgId naming another org is ignored, never honoured.
  it("org token naming another org in ?orgId= reads and writes only its own org", async () => {
    selectQueue = [[]];
    expect((await getReq(`/data-policy?orgId=${ORG_B}`)).status).toBe(200);
    expect(resolveAiDataPolicy).toHaveBeenCalledWith(ORG_A);
    expect(resolveAiDataPolicy).not.toHaveBeenCalledWith(ORG_B);
    expect(resolveAiDataPolicyCeiling).not.toHaveBeenCalledWith(ORG_B);

    expect((await putReq({ deviceFileReadLevel: 'off' }, `/data-policy?orgId=${ORG_B}`)).status).toBe(200);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.values).toMatchObject({ orgId: ORG_A });
    expect(resolveAiDataPolicyCeiling).toHaveBeenLastCalledWith(ORG_A);
    expect(auditLog[0]).toMatchObject({ orgId: ORG_A });
  });

  it('partner token writes the ?orgId= org', async () => {
    currentAuth = partnerAuth();
    expect((await putReq({ deviceFileReadLevel: 'off' })).status).toBe(200);
    expect(writes[0]!.values).toMatchObject({ orgId: ORG_A });
    expect(auditLog[0]).toMatchObject({ orgId: ORG_A });
  });

  it('400s a partner token without orgId', async () => {
    currentAuth = partnerAuth();
    expect((await putReq({ deviceFileReadLevel: 'off' }, '/data-policy')).status).toBe(400);
    expect(writes).toHaveLength(0);
  });

  it('403s a partner token naming an org it cannot access, and writes nothing', async () => {
    currentAuth = partnerAuth();
    const res = await putReq({ deviceFileReadLevel: 'off' }, `/data-policy?orgId=${ORG_B}`);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Access to this organization denied.' });
    expect(resolveAiDataPolicyCeiling).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
    expect(auditLog).toHaveLength(0);
  });

  it('403s a site-restricted caller (org-wide governance object)', async () => {
    currentAuth = orgAuth({ allowedSiteIds: ['site-1'] });
    expect((await putReq({ deviceFileReadLevel: 'off' })).status).toBe(403);
    expect(writes).toHaveLength(0);
  });

  it('403s without ai_agents:write and without MFA', async () => {
    currentPerms = makePerms([PERMISSIONS.AI_AGENTS_READ]);
    expect((await putReq({ deviceFileReadLevel: 'off' })).status).toBe(403);
    currentPerms = makePerms(ALL_GRANTS);
    currentAuth = orgAuth({ token: { mfa: false, sid: 'sid-1' } });
    expect((await putReq({ deviceFileReadLevel: 'off' })).status).toBe(403);
    expect(writes).toHaveLength(0);
  });

  it.each([
    ['retention 0', { toolOutputRetentionDays: 0 }],
    ['transcript retention 0', { transcriptRetentionDays: 0 }],
    ['transcript retention above 3650', { transcriptRetentionDays: 3651 }],
    ['unknown level', { deviceFileReadLevel: 'everything' }],
    ['unknown key (strict)', { other: 1 }],
  ])('400s %s and writes nothing', async (_n, body) => {
    const res = await putReq(body);
    expect(res.status).toBe(400);
    expect(writes).toHaveLength(0);
  });
});

describe('GET /data-policy/transcript-retention-preview', () => {
  const dialect = new PgDialect();
  const previewReq = (qs: string) => aiDataPolicyRoutes.request(`/data-policy/transcript-retention-preview${qs}`);
  const renderedCount = (i = 0) => dialect.sqlToQuery(executeMock.mock.calls[i]![0] as SQL);

  it.each([
    ['days=0', '?days=0'],
    ['days=abc', '?days=abc'],
    ['missing days', ''],
    ['days above 3650', '?days=3651'],
    ['fractional days', '?days=2.5'],
  ])('400s %s and counts nothing', async (_n, qs) => {
    const res = await previewReq(qs);
    expect(res.status).toBe(400);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("counts the org token's own technician sessions at window N, with enforced:false", async () => {
    executeMock.mockResolvedValueOnce([{ n: 7 }]);
    const res = await previewReq('?days=30');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ eligible: 7, capped: false, enforced: false });
    expect(executeMock).toHaveBeenCalledTimes(1);
    const q = renderedCount();
    expect(q.sql).toContain('ai_sessions.type NOT IN');
    expect(q.sql).toContain('ai_sessions.transcript_purged_at IS NULL');
    expect(q.params).toContain(ORG_A);
  });

  it('reports capped when the bounded count overflows', async () => {
    executeMock.mockResolvedValueOnce([{ n: 10_001 }]);
    expect(await (await previewReq('?days=30')).json()).toEqual({ eligible: 10_000, capped: true, enforced: false });
  });

  it('an org token naming another org previews only its own org', async () => {
    executeMock.mockResolvedValueOnce([{ n: 0 }]);
    expect((await previewReq(`?days=30&orgId=${ORG_B}`)).status).toBe(200);
    const q = renderedCount();
    expect(q.params).toContain(ORG_A);
    expect(q.params).not.toContain(ORG_B);
  });

  it('a partner token previews the ?orgId= org it can access', async () => {
    currentAuth = partnerAuth();
    executeMock.mockResolvedValueOnce([{ n: 2 }]);
    const res = await previewReq(`?days=30&orgId=${ORG_A}`);
    expect(res.status).toBe(200);
    expect(renderedCount().params).toContain(ORG_A);
  });

  it('403s a partner token naming an org it cannot access, and counts nothing', async () => {
    currentAuth = partnerAuth();
    const res = await previewReq(`?days=30&orgId=${ORG_B}`);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Access to this organization denied.' });
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('400s a partner token without orgId', async () => {
    currentAuth = partnerAuth();
    expect((await previewReq('?days=30')).status).toBe(400);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('403s without ai_agents:read', async () => {
    currentPerms = makePerms([]);
    expect((await previewReq('?days=30')).status).toBe(403);
    expect(executeMock).not.toHaveBeenCalled();
  });
});
