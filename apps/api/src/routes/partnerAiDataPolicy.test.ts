import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { UserPermissions } from '../services/permissions';

/**
 * Route tests for `partnerAiDataPolicyRoutes` (#8852 W1): the partner default
 * half of `ai_data_policies`. Scope middleware and canManagePartnerWidePolicies
 * stay REAL; only the DB, audit sink, auth identity and permission lookup are
 * mocked (same harness as partnerAiScriptPolicy.test.ts).
 */

const PARTNER = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';

type SelectRow = Record<string, unknown>;
let selectQueue: SelectRow[][] = [];
let writes: Array<{ values: Record<string, unknown>; set: Record<string, unknown>; target: unknown }> = [];
let returningQueue: Array<Record<string, unknown>> = [];

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => selectQueue.shift() ?? []),
          // The preview reads lists without a LIMIT.
          then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
            Promise.resolve(selectQueue.shift() ?? []).then(resolve, reject),
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
                returning: vi.fn(async () => [
                  returningQueue.shift() ?? { id: 'row-1', ...insertedValues, ...opts.set },
                ]),
              };
            }),
          };
        }),
      };
    }),
  },
}));

const auditLog: Array<Record<string, unknown>> = [];
vi.mock('../services/auditService', () => ({
  createAuditLogAsync: vi.fn(async (params: Record<string, unknown>) => {
    auditLog.push(params);
  }),
}));

let currentAuth: Record<string, unknown> = {};
vi.mock('../middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware/auth')>();
  return {
    ...actual,
    authMiddleware: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('auth', currentAuth);
      await next();
    },
  };
});

// Preview counts: the predicate builders stay REAL (so the args are the job's);
// only the bounded count is scripted per org. Keyed by org id.
const previewCounts = new Map<string, number>();
const countCalls: Array<{ orgId: string; cap: number }> = [];
vi.mock('../services/aiTranscriptRetentionPredicates', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/aiTranscriptRetentionPredicates')>();
  return {
    ...actual,
    technicianStubPredicate: vi.fn((orgId: string, cutoffIso: string, now: Date) => ({ orgId, cutoffIso, now })),
    countTranscriptPreview: vi.fn(async (where: { orgId: string }, cap: number = actual.TRANSCRIPT_PREVIEW_CAP) => {
      countCalls.push({ orgId: where.orgId, cap });
      const n = previewCounts.get(where.orgId) ?? 0;
      return { eligible: Math.min(n, cap), capped: n > cap };
    }),
  };
});

let currentPerms: UserPermissions | null = null;
vi.mock('../services/permissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/permissions')>();
  return { ...actual, getUserPermissions: vi.fn(async () => currentPerms) };
});

import { PERMISSIONS } from '../services/permissions';
import { aiDataPolicies } from '../db/schema';
import { partnerAiDataPolicyRoutes } from './partnerAiDataPolicy';
import { technicianStubPredicate, TRANSCRIPT_PREVIEW_CAP } from '../services/aiTranscriptRetentionPredicates';

const ORG = '11111111-1111-4111-8111-111111111111';

function partnerAuth(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    user: { id: USER_ID, email: 'partner-admin@example.com' },
    scope: 'partner',
    orgId: null,
    partnerId: PARTNER,
    partnerOrgAccess: 'all',
    accessibleOrgIds: [],
    token: { mfa: true, sid: 'sid-1' },
    ...overrides,
  };
}

const ALL_GRANTS = [PERMISSIONS.AI_AGENTS_READ, PERMISSIONS.AI_AGENTS_WRITE];
function makePerms(grants: Array<{ resource: string; action: string }>): UserPermissions {
  return { permissions: grants, partnerId: PARTNER, orgId: null, roleId: 'role-1', scope: 'partner' };
}

function policyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'partner-policy-1',
    orgId: null,
    partnerId: PARTNER,
    deviceFileReadLevel: 'no_user_profiles',
    toolOutputRetentionDays: 30,
    transcriptRetentionDays: 365,
    createdBy: USER_ID,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-02T00:00:00Z'),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  selectQueue = [];
  writes = [];
  returningQueue = [];
  auditLog.length = 0;
  previewCounts.clear();
  countCalls.length = 0;
  currentAuth = partnerAuth();
  currentPerms = makePerms(ALL_GRANTS);
});

const getReq = () => partnerAiDataPolicyRoutes.request('/');
const putReq = (body: unknown) =>
  partnerAiDataPolicyRoutes.request('/', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('scope gate', () => {
  it('403s an organization-scope token on GET and PUT', async () => {
    currentAuth = { user: { id: USER_ID, email: 'o@example.com' }, scope: 'organization', orgId: ORG, partnerId: PARTNER, accessibleOrgIds: [ORG] };
    expect((await getReq()).status).toBe(403);
    expect((await putReq({ deviceFileReadLevel: 'off' })).status).toBe(403);
    expect(writes).toHaveLength(0);
  });
});

describe('GET /', () => {
  it('returns null policy, canManage and the built-in defaults when no row exists', async () => {
    selectQueue = [[]];
    const res = await getReq();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      policy: null,
      canManage: true,
      defaults: { deviceFileReadLevel: 'no_user_profiles', toolOutputRetentionDays: 30, transcriptRetentionDays: 365 },
    });
  });

  it('returns the DTO (no createdBy/createdAt) for an existing row', async () => {
    selectQueue = [[policyRow({ deviceFileReadLevel: 'off', toolOutputRetentionDays: null, transcriptRetentionDays: 180 })]];
    const body = await (await getReq()).json();
    expect(body.policy).toEqual({
      id: 'partner-policy-1',
      orgId: null,
      partnerId: PARTNER,
      deviceFileReadLevel: 'off',
      toolOutputRetentionDays: null,
      transcriptRetentionDays: 180,
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
  });

  it('reports canManage:false (not 403) for a restricted partner token', async () => {
    currentAuth = partnerAuth({ partnerOrgAccess: 'selected' });
    selectQueue = [[]];
    const res = await getReq();
    expect(res.status).toBe(200);
    expect((await res.json()).canManage).toBe(false);
  });
  // canManage must mirror EVERY gate the PUT enforces, or the card offers a
  // save that 403s. Reads stay open to the partner scope either way.
  it('reports canManage:false (not 403) without ai_agents:write', async () => {
    currentPerms = makePerms([PERMISSIONS.AI_AGENTS_READ]);
    selectQueue = [[]];
    const res = await getReq();
    expect(res.status).toBe(200);
    expect((await res.json()).canManage).toBe(false);
  });

  it('reports canManage:false (not 403) when no permissions resolve at all (fail closed)', async () => {
    currentPerms = null;
    selectQueue = [[]];
    const res = await getReq();
    expect(res.status).toBe(200);
    expect((await res.json()).canManage).toBe(false);
  });

  it('reports canManage:false (not 403) when MFA is not satisfied', async () => {
    currentAuth = partnerAuth({ token: { mfa: false, sid: 'sid-1' } });
    selectQueue = [[]];
    const res = await getReq();
    expect(res.status).toBe(200);
    expect((await res.json()).canManage).toBe(false);
  });
});

describe('PUT /', () => {
  it('403s without canManagePartnerWidePolicies and writes nothing', async () => {
    currentAuth = partnerAuth({ partnerOrgAccess: 'selected' });
    const res = await putReq({ deviceFileReadLevel: 'off' });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/partner-wide/i);
    expect(writes).toHaveLength(0);
    expect(auditLog).toHaveLength(0);
  });

  it('403s without ai_agents:write', async () => {
    currentPerms = makePerms([PERMISSIONS.AI_AGENTS_READ]);
    expect((await putReq({ deviceFileReadLevel: 'off' })).status).toBe(403);
    expect(writes).toHaveLength(0);
  });

  it('403s when MFA is not satisfied', async () => {
    currentAuth = partnerAuth({ token: { mfa: false, sid: 'sid-1' } });
    expect((await putReq({ deviceFileReadLevel: 'off' })).status).toBe(403);
    expect(writes).toHaveLength(0);
  });

  it('upserts on partner_id and audits with partnerId set and orgId null', async () => {
    const res = await putReq({ deviceFileReadLevel: 'any_with_approval', toolOutputRetentionDays: 90 });
    expect(res.status).toBe(200);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.target).toBe(aiDataPolicies.partnerId);
    expect(writes[0]!.values).toEqual({
      partnerId: PARTNER,
      orgId: null,
      createdBy: USER_ID,
      deviceFileReadLevel: 'any_with_approval',
      toolOutputRetentionDays: 90,
      // Absent from the body: a first insert seeds the 365-day default.
      transcriptRetentionDays: 365,
    });
    expect(writes[0]!.set).toMatchObject({ deviceFileReadLevel: 'any_with_approval', toolOutputRetentionDays: 90 });
    expect(writes[0]!.set.updatedAt).toBeInstanceOf(Date);
    const body = await res.json();
    expect(body.policy).toMatchObject({ id: 'row-1', partnerId: PARTNER, orgId: null, deviceFileReadLevel: 'any_with_approval', toolOutputRetentionDays: 90 });
    expect(auditLog).toHaveLength(1);
    expect(auditLog[0]).toMatchObject({
      orgId: null,
      partnerId: PARTNER,
      actorType: 'user',
      actorId: USER_ID,
      actorEmail: 'partner-admin@example.com',
      action: 'ai.data_policy.updated',
      resourceType: 'ai_data_policies',
      resourceId: 'row-1',
      details: { level: 'partner', deviceFileReadLevel: 'any_with_approval', toolOutputRetentionDays: 90 },
      result: 'success',
    });
  });

  it('accepts null to clear a field (keep forever / no opinion)', async () => {
    const res = await putReq({ deviceFileReadLevel: null, toolOutputRetentionDays: null });
    expect(res.status).toBe(200);
    expect(writes[0]!.set).toMatchObject({ deviceFileReadLevel: null, toolOutputRetentionDays: null });
  });

  it('seeds the 30-day default on first insert when the body omits retention, without touching it on conflict', async () => {
    const res = await putReq({ deviceFileReadLevel: 'off' });
    expect(res.status).toBe(200);
    expect(writes[0]!.values).toMatchObject({ deviceFileReadLevel: 'off', toolOutputRetentionDays: 30 });
    expect(writes[0]!.set).not.toHaveProperty('toolOutputRetentionDays');
  });

  it('an explicit null retention stores NULL (keep forever) in both insert and conflict set', async () => {
    const res = await putReq({ toolOutputRetentionDays: null });
    expect(res.status).toBe(200);
    expect(writes[0]!.values.toolOutputRetentionDays).toBeNull();
    expect(writes[0]!.set.toolOutputRetentionDays).toBeNull();
  });

  it('seeds the 365-day transcript default on first insert when the body omits it, without touching it on conflict', async () => {
    const res = await putReq({ toolOutputRetentionDays: 14 });
    expect(res.status).toBe(200);
    expect(writes[0]!.values).toMatchObject({ toolOutputRetentionDays: 14, transcriptRetentionDays: 365 });
    expect(writes[0]!.set).not.toHaveProperty('transcriptRetentionDays');
  });

  it('writes an explicit transcript window to insert and conflict set, and returns it', async () => {
    const res = await putReq({ transcriptRetentionDays: 90 });
    expect(res.status).toBe(200);
    expect(writes[0]!.values.transcriptRetentionDays).toBe(90);
    expect(writes[0]!.set.transcriptRetentionDays).toBe(90);
    expect((await res.json()).policy.transcriptRetentionDays).toBe(90);
    expect(auditLog[0]).toMatchObject({ details: { level: 'partner', transcriptRetentionDays: 90 } });
  });

  it('an explicit null transcript window stores NULL (keep forever) in both insert and conflict set', async () => {
    const res = await putReq({ transcriptRetentionDays: null });
    expect(res.status).toBe(200);
    expect(writes[0]!.values.transcriptRetentionDays).toBeNull();
    expect(writes[0]!.set.transcriptRetentionDays).toBeNull();
  });

  it.each([
    ['retention 0', { toolOutputRetentionDays: 0 }],
    ['retention above 3650', { toolOutputRetentionDays: 3651 }],
    ['transcript retention 0', { transcriptRetentionDays: 0 }],
    ['transcript retention above 3650', { transcriptRetentionDays: 3651 }],
    ['fractional transcript retention', { transcriptRetentionDays: 30.5 }],
    ['fractional retention', { toolOutputRetentionDays: 1.5 }],
    ['unknown level', { deviceFileReadLevel: 'everything' }],
    ['unknown key (strict)', { somethingElse: true }],
  ])('rejects %s with 400 and writes nothing', async (_n, body) => {
    const res = await putReq(body);
    expect(res.status).toBe(400);
    expect(writes).toHaveLength(0);
    expect(auditLog).toHaveLength(0);
  });
});

describe('GET /transcript-retention-preview', () => {
  const ORG_2 = '44444444-4444-4444-8444-444444444444';
  const ORG_3 = '55555555-5555-4555-8555-555555555555';
  const ORG_4 = '66666666-6666-4666-8666-666666666666';
  const previewReq = (qs: string) => partnerAiDataPolicyRoutes.request(`/transcript-retention-preview${qs}`);

  it.each([
    ['days=0', '?days=0'],
    ['days=abc', '?days=abc'],
    ['missing days', ''],
    ['days above 3650', '?days=3651'],
    ['fractional days', '?days=1.5'],
    ['negative days', '?days=-5'],
  ])('400s %s and counts nothing', async (_n, qs) => {
    const res = await previewReq(qs);
    expect(res.status).toBe(400);
    expect(countCalls).toHaveLength(0);
  });

  it('403s an organization-scope token (partner preview is partner-only)', async () => {
    currentAuth = { user: { id: USER_ID, email: 'o@example.com' }, scope: 'organization', orgId: ORG, partnerId: PARTNER, accessibleOrgIds: [ORG] };
    expect((await previewReq('?days=90')).status).toBe(403);
    expect(countCalls).toHaveLength(0);
  });

  it('403s a partner caller without ai_agents:read (the preview counts AI sessions)', async () => {
    currentPerms = makePerms([]);
    expect((await previewReq('?days=90')).status).toBe(403);
    expect(countCalls).toHaveLength(0);
  });

  it('400s without a partner context', async () => {
    currentAuth = partnerAuth({ scope: 'system', partnerId: null });
    expect((await previewReq('?days=90')).status).toBe(400);
    expect(countCalls).toHaveLength(0);
  });

  it('sums the partner orgs that have no tighter org row, at window N, with enforced:false', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-11T12:00:00.000Z'));
    try {
      // 1) the partner's orgs (caller RLS), 2) their org-level policy rows.
      selectQueue = [
        [{ id: ORG }, { id: ORG_2 }, { id: ORG_3 }, { id: ORG_4 }],
        [
          { orgId: ORG_2, transcriptRetentionDays: 30 }, // tighter than 90: unaffected
          { orgId: ORG_3, transcriptRetentionDays: 120 }, // looser: partner 90 applies
          { orgId: ORG_4, transcriptRetentionDays: null }, // inherits
        ],
      ];
      previewCounts.set(ORG, 3).set(ORG_2, 50).set(ORG_3, 4).set(ORG_4, 1);
      const res = await previewReq('?days=90');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ eligible: 8, capped: false, enforced: false });
      expect(countCalls.map((call) => call.orgId)).toEqual([ORG, ORG_3, ORG_4]);
      expect(technicianStubPredicate).toHaveBeenCalledWith(ORG, '2026-08-13T12:00:00.000Z', new Date('2026-11-11T12:00:00.000Z'));
    } finally {
      vi.useRealTimers();
    }
  });

  it('an org row exactly at N is still governed by the partner value', async () => {
    selectQueue = [[{ id: ORG }], [{ orgId: ORG, transcriptRetentionDays: 90 }]];
    previewCounts.set(ORG, 2);
    expect(await (await previewReq('?days=90')).json()).toEqual({ eligible: 2, capped: false, enforced: false });
  });

  it('stops summing at the preview cap and reports capped', async () => {
    selectQueue = [[{ id: ORG }, { id: ORG_2 }, { id: ORG_3 }], []];
    previewCounts.set(ORG, 6000).set(ORG_2, 6000).set(ORG_3, 5);
    const body = await (await previewReq('?days=30')).json();
    expect(body).toEqual({ eligible: TRANSCRIPT_PREVIEW_CAP, capped: true, enforced: false });
    // Each org is counted only up to what is left of the cap; nothing after the cap.
    expect(countCalls).toEqual([
      { orgId: ORG, cap: TRANSCRIPT_PREVIEW_CAP },
      { orgId: ORG_2, cap: TRANSCRIPT_PREVIEW_CAP - 6000 },
    ]);
  });

  it('returns zero (and reads no policy rows) for a partner with no visible orgs', async () => {
    selectQueue = [[]];
    expect(await (await previewReq('?days=30')).json()).toEqual({ eligible: 0, capped: false, enforced: false });
    expect(countCalls).toHaveLength(0);
  });
});
