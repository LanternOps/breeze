import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { UserPermissions } from '../../services/permissions';

/**
 * Route tests for `aiScriptPolicyRoutes` (#5612 W04): the org-grant half of
 * the unattended script lane policy plus the per-org lane circuit reset.
 * `requirePermission`/`requireScope`/`hasSatisfiedMfa` are left REAL (only
 * the permission lookup is mocked) so the permission/MFA/step-up matrix is
 * genuinely exercised, matching the harness pattern in
 * `scriptProposals.promote.test.ts`.
 */

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '99999999-9999-4999-8999-999999999999';
const PARTNER = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';

type SelectRow = Record<string, unknown>;

let selectQueue: SelectRow[][] = [];
let writes: Array<{ values: Record<string, unknown>; set: Record<string, unknown> }> = [];
let returningQueue: Array<Record<string, unknown>> = [];

vi.mock('../../db', () => ({
  db: {
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
            onConflictDoUpdate: vi.fn((opts: { set: Record<string, unknown> }) => {
              writes.push({ values: insertedValues, set: opts.set });
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

const resolveEffectiveScriptPolicy = vi.fn();
vi.mock('../../services/scriptProposals/policy', () => ({
  resolveEffectiveScriptPolicy: (...a: unknown[]) => resolveEffectiveScriptPolicy(...a),
}));

const getUserEpochs = vi.fn();
vi.mock('../../services/authEpochs', () => ({
  getUserEpochs: (...a: unknown[]) => getUserEpochs(...a),
}));

const consumeStepUpGrant = vi.fn();
vi.mock('../../services/mfaStepUpGrant', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/mfaStepUpGrant')>();
  return {
    ...actual,
    consumeStepUpGrant: (...a: Parameters<typeof actual.consumeStepUpGrant>) => consumeStepUpGrant(...a),
  };
});

const auditLog: Array<Record<string, unknown>> = [];
vi.mock('../../services/auditService', () => ({
  createAuditLogAsync: vi.fn(async (params: Record<string, unknown>) => {
    auditLog.push(params);
  }),
}));

// ENABLE_2FA lives in routes/auth/schemas.ts (envFlag('ENABLE_2FA', true));
// pinned true so the step-up branch is exercised regardless of the host env.
vi.mock('../auth/schemas', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ENABLE_2FA: true,
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
  return {
    ...actual,
    getUserPermissions: vi.fn(async () => currentPerms),
  };
});

import { PERMISSIONS } from '../../services/permissions';
import { scriptLanePolicyResourceDigest } from '../../services/mfaStepUpGrant';
import { aiScriptPolicyRoutes, toScriptPolicyDto } from './scriptPolicy';
import type { AiScriptPolicyRow } from '../../db/schema/aiScriptPolicies';
import type { AiScriptLaneStateRow } from '../../db/schema/aiScriptLaneState';

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

function makePerms(grants: Array<{ resource: string; action: string }>): UserPermissions {
  return {
    permissions: grants,
    partnerId: null,
    orgId: ORG_A,
    roleId: 'role-1',
    scope: 'organization',
  };
}

const ALL_GRANTS = [PERMISSIONS.AI_AGENTS_READ, PERMISSIONS.AI_AGENTS_WRITE, PERMISSIONS.APPROVALS_DECIDE];

const DEFAULT_EFFECTIVE = {
  proposingEnabled: true,
  unattendedEnabled: false,
  maxUnattendedRiskTier: 'low' as const,
  unattendedAllowedClasses: ['services', 'processes', 'temp_files', 'dns_cache', 'printing'],
  maxUnattendedPerHour: 10,
  protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
  reviewerModel: null,
  source: { partnerRowId: null, orgRowId: null },
};

function policyRow(overrides: Partial<AiScriptPolicyRow> = {}): AiScriptPolicyRow {
  return {
    id: 'policy-1',
    orgId: ORG_A,
    partnerId: null,
    proposingEnabled: true,
    unattendedAllowed: false,
    unattendedEnabled: false,
    maxUnattendedRiskTier: 'low',
    unattendedAllowedClasses: ['services'],
    maxUnattendedPerHour: 5,
    protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
    reviewerModel: null,
    unattendedEnabledBy: null,
    unattendedEnabledAt: null,
    createdBy: USER_ID,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  } as AiScriptPolicyRow;
}

function laneRow(overrides: Partial<AiScriptLaneStateRow> = {}): AiScriptLaneStateRow {
  return {
    orgId: ORG_A,
    consecutiveFailedVerifications: 0,
    state: 'closed',
    openedAt: null,
    openedReason: null,
    resetByUserId: null,
    resetAt: null,
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  } as AiScriptLaneStateRow;
}

beforeEach(() => {
  vi.clearAllMocks();
  selectQueue = [];
  writes = [];
  returningQueue = [];
  auditLog.length = 0;
  currentAuth = orgAuth();
  currentPerms = makePerms(ALL_GRANTS);
  resolveEffectiveScriptPolicy.mockResolvedValue(DEFAULT_EFFECTIVE);
  getUserEpochs.mockResolvedValue({ authEpoch: 1, mfaEpoch: 1 });
  consumeStepUpGrant.mockResolvedValue(true);
});

const getReq = (query = '') => aiScriptPolicyRoutes.request(`/script-policy${query}`);
const putReq = (body: unknown, query = '') =>
  aiScriptPolicyRoutes.request(`/script-policy${query}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
const resetReq = (body: unknown = {}) =>
  aiScriptPolicyRoutes.request('/script-lane/reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('GET /script-policy', () => {
  it('403s without ai_agents:read', async () => {
    currentPerms = makePerms([]);
    expect((await getReq()).status).toBe(403);
  });

  it('200s and returns policy + effective + laneState shape', async () => {
    selectQueue = [[policyRow({ unattendedEnabled: true, unattendedEnabledAt: new Date('2026-02-01T00:00:00Z') })], [laneRow({ state: 'open', consecutiveFailedVerifications: 2, openedAt: new Date('2026-02-02T00:00:00Z'), openedReason: 'bad_verification' })]];
    resolveEffectiveScriptPolicy.mockResolvedValue({ ...DEFAULT_EFFECTIVE, source: { partnerRowId: 'partner-row-1', orgRowId: 'policy-1' } });

    const res = await getReq();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      policy: toScriptPolicyDto(policyRow({ unattendedEnabled: true, unattendedEnabledAt: new Date('2026-02-01T00:00:00Z') })),
      effective: {
        proposingEnabled: DEFAULT_EFFECTIVE.proposingEnabled,
        unattendedEnabled: DEFAULT_EFFECTIVE.unattendedEnabled,
        maxUnattendedRiskTier: DEFAULT_EFFECTIVE.maxUnattendedRiskTier,
        unattendedAllowedClasses: DEFAULT_EFFECTIVE.unattendedAllowedClasses,
        maxUnattendedPerHour: DEFAULT_EFFECTIVE.maxUnattendedPerHour,
      },
      partnerCeilingPresent: true,
      laneState: {
        state: 'open',
        consecutiveFailedVerifications: 2,
        openedAt: '2026-02-02T00:00:00.000Z',
        openedReason: 'bad_verification',
        resetAt: null,
      },
    });
  });

  it('returns policy:null and a default (closed) laneState when no rows exist', async () => {
    selectQueue = [[], []];
    resolveEffectiveScriptPolicy.mockResolvedValue(DEFAULT_EFFECTIVE);

    const res = await getReq();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.policy).toBeNull();
    expect(body.partnerCeilingPresent).toBe(false);
    expect(body.laneState).toEqual({
      state: 'closed',
      consecutiveFailedVerifications: 0,
      openedAt: null,
      openedReason: null,
      resetAt: null,
    });
  });

  it('400s a partner-scope token with no ?orgId=', async () => {
    currentAuth = orgAuth({ scope: 'partner', orgId: null, accessibleOrgIds: [], canAccessOrg: () => true });
    const res = await getReq();
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'orgId is required' });
  });

  it('400s a partner-scope token whose ?orgId= is not accessible', async () => {
    currentAuth = orgAuth({ scope: 'partner', orgId: null, accessibleOrgIds: [ORG_A], canAccessOrg: (id: string) => id === ORG_A });
    const res = await getReq(`?orgId=${ORG_B}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'orgId is required' });
  });
});

describe('PUT /script-policy', () => {
  it('403s without ai_agents:write', async () => {
    currentPerms = makePerms([PERMISSIONS.AI_AGENTS_READ]);
    expect((await putReq({ proposingEnabled: true })).status).toBe(403);
  });

  it('400s on an invalid body (strict schema rejects an unknown key)', async () => {
    const res = await putReq({ notARealField: true });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(typeof body.error).toBe('string');
  });

  it('400s on an unknown touch class', async () => {
    const res = await putReq({ unattendedAllowedClasses: ['not_a_real_class'] });
    expect(res.status).toBe(400);
  });

  it('422s above_partner_ceiling when a class exceeds the effective allowlist', async () => {
    resolveEffectiveScriptPolicy.mockResolvedValue({ ...DEFAULT_EFFECTIVE, unattendedAllowedClasses: ['services'] });
    const res = await putReq({ unattendedAllowedClasses: ['services', 'processes'] });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'above_partner_ceiling', field: 'unattendedAllowedClasses' });
  });

  it('422s when maxUnattendedRiskTier exceeds the effective ceiling', async () => {
    resolveEffectiveScriptPolicy.mockResolvedValue({ ...DEFAULT_EFFECTIVE, maxUnattendedRiskTier: 'low' });
    const res = await putReq({ maxUnattendedRiskTier: 'medium' });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'above_partner_ceiling', field: 'maxUnattendedRiskTier' });
  });

  it('422s when maxUnattendedPerHour exceeds the effective ceiling', async () => {
    resolveEffectiveScriptPolicy.mockResolvedValue({ ...DEFAULT_EFFECTIVE, maxUnattendedPerHour: 5 });
    const res = await putReq({ maxUnattendedPerHour: 10 });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'above_partner_ceiling', field: 'maxUnattendedPerHour' });
  });

  it('403s APPROVALS_DECIDE_REQUIRED when enabling without approvals:decide, even with a grant', async () => {
    currentPerms = makePerms([PERMISSIONS.AI_AGENTS_WRITE]);
    const res = await putReq({ unattendedEnabled: true, stepUpGrant: 'grant-1' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'approvals:decide is required for this change', code: 'APPROVALS_DECIDE_REQUIRED' });
    expect(consumeStepUpGrant).not.toHaveBeenCalled();
  });

  it('403s MFA_REQUIRED when enabling with approvals:decide but token.mfa false', async () => {
    currentAuth = orgAuth({ token: { mfa: false, sid: 'sid-1' } });
    const res = await putReq({ unattendedEnabled: true, stepUpGrant: 'grant-1' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'MFA required', code: 'MFA_REQUIRED' });
    expect(consumeStepUpGrant).not.toHaveBeenCalled();
  });

  it('403s STEP_UP_REQUIRED when enabling without a stepUpGrant', async () => {
    const res = await putReq({ unattendedEnabled: true });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Step-up required', code: 'STEP_UP_REQUIRED' });
    expect(consumeStepUpGrant).not.toHaveBeenCalled();
  });

  it('403s STEP_UP_REQUIRED when consumeStepUpGrant returns false', async () => {
    consumeStepUpGrant.mockResolvedValue(false);
    const res = await putReq({ unattendedEnabled: true, stepUpGrant: 'grant-1' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Step-up required', code: 'STEP_UP_REQUIRED' });
  });

  it('200s enabling with approvals:decide + mfa + a consumed step-up grant', async () => {
    const res = await putReq({ unattendedEnabled: true, stepUpGrant: 'grant-1' });
    expect(res.status).toBe(200);

    expect(consumeStepUpGrant).toHaveBeenCalledTimes(1);
    const [grantId, binding] = consumeStepUpGrant.mock.calls[0] as [string, { operation: string; resourceDigest: string }];
    expect(grantId).toBe('grant-1');
    expect(binding.operation).toBe('ai_script_lane_grant');
    expect(binding.resourceDigest).toBe(scriptLanePolicyResourceDigest({ orgId: ORG_A, unattendedEnabled: true }));

    expect(writes).toHaveLength(1);
    expect(writes[0].values).toMatchObject({ unattendedEnabled: true, unattendedEnabledBy: USER_ID });
    expect(writes[0].values.unattendedEnabledAt).toBeInstanceOf(Date);

    expect(auditLog).toHaveLength(1);
    expect(auditLog[0].action).toBe('ai.script_lane.enabled');
  });

  it('200s disabling without approvals:decide or a step-up grant, and audits ai.script_policy.updated', async () => {
    currentPerms = makePerms([PERMISSIONS.AI_AGENTS_WRITE]);
    const res = await putReq({ unattendedEnabled: false });
    expect(res.status).toBe(200);
    expect(consumeStepUpGrant).not.toHaveBeenCalled();
    expect(auditLog).toHaveLength(1);
    expect(auditLog[0].action).toBe('ai.script_policy.updated');
  });

  it('strips stepUpGrant from the persisted columns', async () => {
    const res = await putReq({ proposingEnabled: true, stepUpGrant: 'unused-grant' });
    expect(res.status).toBe(200);
    expect(writes).toHaveLength(1);
    expect(writes[0].values).not.toHaveProperty('stepUpGrant');
    expect(writes[0].set).not.toHaveProperty('stepUpGrant');
  });
});

describe('POST /script-lane/reset', () => {
  it('403s without approvals:decide', async () => {
    currentPerms = makePerms([PERMISSIONS.AI_AGENTS_WRITE]);
    expect((await resetReq()).status).toBe(403);
  });

  it('403s STEP_UP_REQUIRED without a grant', async () => {
    const res = await resetReq({});
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Step-up required', code: 'STEP_UP_REQUIRED' });
  });

  it('403s STEP_UP_REQUIRED when consumeStepUpGrant returns false', async () => {
    consumeStepUpGrant.mockResolvedValue(false);
    const res = await resetReq({ stepUpGrant: 'grant-1' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Step-up required', code: 'STEP_UP_REQUIRED' });
  });

  it('200s with a consumed step-up grant', async () => {
    const res = await resetReq({ stepUpGrant: 'grant-1' });
    expect(res.status).toBe(200);

    const [, binding] = consumeStepUpGrant.mock.calls[0] as [string, { resourceDigest: string }];
    expect(binding.resourceDigest).toBe(scriptLanePolicyResourceDigest({ orgId: ORG_A, unattendedEnabled: true, reset: true }));

    expect(writes).toHaveLength(1);
    expect(writes[0].set).toMatchObject({
      state: 'closed',
      consecutiveFailedVerifications: 0,
      openedAt: null,
      resetByUserId: USER_ID,
    });

    expect(auditLog).toHaveLength(1);
    expect(auditLog[0].action).toBe('ai.script_lane.reset');
  });
});
