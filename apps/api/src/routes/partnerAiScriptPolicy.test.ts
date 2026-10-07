import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { UserPermissions } from '../services/permissions';

/**
 * Route tests for `partnerAiScriptPolicyRoutes` (#5612 W04): the PARTNER
 * ceiling half of `ai_script_policies`. `requireScope` and
 * `canManagePartnerWidePolicies` are left REAL (no mocking of
 * `../middleware/auth` behaviour or `../services/partnerWideAccess`) so the
 * scope/partner-wide-write gate is genuinely exercised. `requirePermission`'s
 * permission lookup and step-up grant consumption are mocked (same harness
 * pattern as `ai/scriptPolicy.test.ts`) so the permission/MFA/step-up matrix
 * is exercised without a live DB.
 */

const PARTNER = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';

type SelectRow = Record<string, unknown>;

let selectQueue: SelectRow[][] = [];
let writes: Array<{ values: Record<string, unknown>; set: Record<string, unknown> }> = [];
let returningQueue: Array<Record<string, unknown>> = [];

vi.mock('../db', () => ({
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

const getUserEpochs = vi.fn();
vi.mock('../services/authEpochs', () => ({
  getUserEpochs: (...a: unknown[]) => getUserEpochs(...a),
}));

const consumeStepUpGrant = vi.fn();
vi.mock('../services/mfaStepUpGrant', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/mfaStepUpGrant')>();
  return {
    ...actual,
    consumeStepUpGrant: (...a: Parameters<typeof actual.consumeStepUpGrant>) => consumeStepUpGrant(...a),
  };
});

// ENABLE_2FA lives in routes/auth/schemas.ts (envFlag('ENABLE_2FA', true));
// pinned true so the step-up branch is exercised regardless of the host env.
vi.mock('./auth/schemas', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ENABLE_2FA: true,
}));

let currentPerms: UserPermissions | null = null;
vi.mock('../services/permissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/permissions')>();
  return {
    ...actual,
    getUserPermissions: vi.fn(async () => currentPerms),
  };
});

import { PERMISSIONS } from '../services/permissions';
import { partnerScriptCeilingResourceDigest } from '../services/mfaStepUpGrant';
import { partnerScriptCeilingStepUpResource } from './auth/schemas';
import { partnerScriptCeilingGrantResource } from '@breeze/shared';
import { partnerAiScriptPolicyRoutes } from './partnerAiScriptPolicy';
import { toScriptPolicyDto } from './ai/scriptPolicy';
import type { AiScriptPolicyRow } from '../db/schema/aiScriptPolicies';

function orgAuth(): Record<string, unknown> {
  return {
    user: { id: USER_ID, email: 'org-user@example.com' },
    scope: 'organization',
    orgId: '11111111-1111-4111-8111-111111111111',
    partnerId: PARTNER,
    accessibleOrgIds: ['11111111-1111-4111-8111-111111111111'],
  };
}

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

function makePerms(grants: Array<{ resource: string; action: string }>): UserPermissions {
  return {
    permissions: grants,
    partnerId: PARTNER,
    orgId: null,
    roleId: 'role-1',
    scope: 'partner',
  };
}

const ALL_GRANTS = [PERMISSIONS.AI_AGENTS_READ, PERMISSIONS.AI_AGENTS_WRITE, PERMISSIONS.APPROVALS_DECIDE];

function partnerPolicyRow(overrides: Partial<AiScriptPolicyRow> = {}): AiScriptPolicyRow {
  return {
    id: 'partner-policy-1',
    orgId: null,
    partnerId: PARTNER,
    proposingEnabled: true,
    unattendedAllowed: false,
    unattendedEnabled: false,
    maxUnattendedRiskTier: 'low',
    unattendedAllowedClasses: ['services'],
    maxUnattendedPerHour: 5,
    protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
    unattendedEnabledBy: null,
    unattendedEnabledAt: null,
    createdBy: USER_ID,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  } as AiScriptPolicyRow;
}

beforeEach(() => {
  vi.clearAllMocks();
  selectQueue = [];
  writes = [];
  returningQueue = [];
  auditLog.length = 0;
  currentAuth = partnerAuth();
  currentPerms = makePerms(ALL_GRANTS);
  getUserEpochs.mockResolvedValue({ authEpoch: 1, mfaEpoch: 1 });
  consumeStepUpGrant.mockResolvedValue(true);
});

const getReq = () => partnerAiScriptPolicyRoutes.request('/');
const putReq = (body: unknown) =>
  partnerAiScriptPolicyRoutes.request('/', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('scope gate', () => {
  it('403s an organization-scope token', async () => {
    currentAuth = orgAuth();
    expect((await getReq()).status).toBe(403);
    expect((await putReq({ unattendedAllowed: true })).status).toBe(403);
  });
});

describe('GET /', () => {
  it('403s never happens for a restricted partner token — it reports canManage:false instead', async () => {
    currentAuth = partnerAuth({ partnerOrgAccess: 'selected' });
    selectQueue = [[]];
    const res = await getReq();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ policy: null, canManage: false, partnerId: PARTNER });
  });

  it('returns the DTO for a queued partner row', async () => {
    selectQueue = [[partnerPolicyRow({ unattendedAllowed: true })]];
    const res = await getReq();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.policy).toEqual(toScriptPolicyDto(partnerPolicyRow({ unattendedAllowed: true })));
    expect(body.policy.ownerScope).toBe('partner');
    expect(body.canManage).toBe(true);
    // The web mints the ceiling's step-up grant with this id (#8112).
    expect(body.partnerId).toBe(PARTNER);
  });

  it('returns policy:null when no partner row exists', async () => {
    selectQueue = [[]];
    const res = await getReq();
    expect(res.status).toBe(200);
    expect((await res.json()).policy).toBeNull();
  });
});

describe('PUT /', () => {
  it('403s PARTNER_WIDE_WRITE_DENIED_MESSAGE for a partner token without full org access', async () => {
    currentAuth = partnerAuth({ partnerOrgAccess: 'selected' });
    const res = await putReq({ unattendedAllowed: true });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/full partner org access/);
  });

  it('403s without ai_agents:write', async () => {
    currentPerms = makePerms([PERMISSIONS.AI_AGENTS_READ]);
    expect((await putReq({ proposingEnabled: true })).status).toBe(403);
  });

  it('403s MFA_REQUIRED when the MFA claim is false, even for a non-widening change', async () => {
    currentAuth = partnerAuth({ token: { mfa: false, sid: 'sid-1' } });
    const res = await putReq({ proposingEnabled: true });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'MFA required', code: 'MFA_REQUIRED' });
  });

  it('403s APPROVALS_DECIDE_REQUIRED when enabling unattendedAllowed without approvals:decide, even with a grant', async () => {
    currentPerms = makePerms([PERMISSIONS.AI_AGENTS_WRITE]);
    const res = await putReq({ unattendedAllowed: true, stepUpGrant: 'grant-1' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'approvals:decide is required for this change', code: 'APPROVALS_DECIDE_REQUIRED' });
    expect(consumeStepUpGrant).not.toHaveBeenCalled();
  });

  it('403s STEP_UP_REQUIRED when enabling unattendedAllowed without a stepUpGrant', async () => {
    const res = await putReq({ unattendedAllowed: true });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Step-up required', code: 'STEP_UP_REQUIRED' });
    expect(consumeStepUpGrant).not.toHaveBeenCalled();
  });

  it('403s STEP_UP_REQUIRED when consumeStepUpGrant returns false', async () => {
    consumeStepUpGrant.mockResolvedValue(false);
    const res = await putReq({ unattendedAllowed: true, stepUpGrant: 'grant-1' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Step-up required', code: 'STEP_UP_REQUIRED' });
  });

  it('200s for a full partner admin with a consumed step-up grant and persists the ceiling row', async () => {
    const res = await putReq({ unattendedAllowed: true, maxUnattendedRiskTier: 'medium', stepUpGrant: 'grant-1' });
    expect(res.status).toBe(200);

    expect(consumeStepUpGrant).toHaveBeenCalledTimes(1);
    const [grantId, binding] = consumeStepUpGrant.mock.calls[0] as [string, { operation: string; resourceDigest: string }];
    expect(grantId).toBe('grant-1');
    expect(binding.operation).toBe('ai_partner_script_ceiling_grant');
    // The enable-branch digest binds the FULL effective ceiling being saved
    // in this request, not just the boolean — a request that also raises
    // the tier in the same call must have that tier value bound in, so a
    // grant minted only for "turn the lane on" cannot be replayed against a
    // wider save.
    expect(binding.resourceDigest).toBe(partnerScriptCeilingResourceDigest({
      partnerId: PARTNER,
      unattendedAllowed: true,
      widening: {
        maxUnattendedRiskTier: 'medium',
        unattendedAllowedClasses: [],
        maxUnattendedPerHour: 0,
        protectedResourcesEmptied: true,
        proposingEnabled: true,
      },
    }));

    expect(writes).toHaveLength(1);
    expect(writes[0]!.values).toMatchObject({
      partnerId: PARTNER,
      orgId: null,
      unattendedAllowed: true,
      maxUnattendedRiskTier: 'medium',
    });
    expect(writes[0]!.values).not.toHaveProperty('stepUpGrant');

    expect(auditLog).toHaveLength(1);
    expect(auditLog[0]!.action).toBe('ai.script_policy.partner_updated');
  });

  it('a step-up grant minted for a narrow "turn on" cannot be replayed to enable at a wider tier in the same call', async () => {
    // Mint a grant bound to the digest for a BARE enable (no widening — what
    // an operator's MFA ceremony would have shown for "just turn this on").
    // Redeeming it against a PUT that simultaneously sets the ceiling to
    // 'medium' must fail: the digest this route computes for that PUT now
    // includes the tier, so it will not match a grant bound to the narrow
    // digest.
    consumeStepUpGrant.mockImplementation(async (_grantId: string, binding: { resourceDigest: string }) =>
      binding.resourceDigest === partnerScriptCeilingResourceDigest({ partnerId: PARTNER, unattendedAllowed: true }));
    const res = await putReq({ unattendedAllowed: true, maxUnattendedRiskTier: 'medium', stepUpGrant: 'grant-1' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Step-up required', code: 'STEP_UP_REQUIRED' });
    expect(writes).toHaveLength(0);
  });

  it('200s disabling (or a non-widening update) without approvals:decide or a step-up grant', async () => {
    currentPerms = makePerms([PERMISSIONS.AI_AGENTS_WRITE]);
    const res = await putReq({ unattendedAllowed: false, maxUnattendedPerHour: 3 });
    expect(res.status).toBe(200);
    expect(consumeStepUpGrant).not.toHaveBeenCalled();
  });

  it('requires a step-up grant to WIDEN an already-allowed ceiling (raise the risk tier)', async () => {
    selectQueue = [[partnerPolicyRow({ unattendedAllowed: true, maxUnattendedRiskTier: 'low' })]];
    const res = await putReq({ maxUnattendedRiskTier: 'medium' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Step-up required', code: 'STEP_UP_REQUIRED' });
    expect(writes).toHaveLength(0);
  });

  it('200s WIDENING an already-allowed ceiling with a consumed step-up grant bound to the wider values', async () => {
    selectQueue = [[partnerPolicyRow({ unattendedAllowed: true, maxUnattendedRiskTier: 'low', unattendedAllowedClasses: ['services'], maxUnattendedPerHour: 5 })]];
    const res = await putReq({ maxUnattendedRiskTier: 'medium', stepUpGrant: 'grant-1' });
    expect(res.status).toBe(200);

    const [, binding] = consumeStepUpGrant.mock.calls[0] as [string, { resourceDigest: string }];
    expect(binding.resourceDigest).toBe(partnerScriptCeilingResourceDigest({
      partnerId: PARTNER,
      unattendedAllowed: true,
      widening: {
        maxUnattendedRiskTier: 'medium',
        unattendedAllowedClasses: ['services'],
        maxUnattendedPerHour: 5,
        protectedResourcesEmptied: false,
        proposingEnabled: true,
      },
    }));
  });

  it('does not require a step-up grant when a currently-allowed ceiling is only tightened', async () => {
    selectQueue = [[partnerPolicyRow({ unattendedAllowed: true, maxUnattendedRiskTier: 'medium', maxUnattendedPerHour: 10 })]];
    const res = await putReq({ maxUnattendedPerHour: 3 });
    expect(res.status).toBe(200);
    expect(consumeStepUpGrant).not.toHaveBeenCalled();
  });

  it('PUT /partner/ai/script-policy with reviewerModel → 400 naming the replacement; nothing is written', async () => {
    for (const reviewerModel of ['claude-x', null]) {
      selectQueue = [[partnerPolicyRow({ unattendedAllowed: true })]];
      const res = await putReq({ maxUnattendedPerHour: 3, reviewerModel });
      expect(res.status).toBe(400);
      const text = JSON.stringify(await res.json());
      expect(text).toContain('reviewerModel');
      expect(text).toContain('script_reviewer');
    }
    expect(consumeStepUpGrant).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
    expect(auditLog).toHaveLength(0);
  });

  it('GET /partner/ai/script-policy no longer returns reviewerModel', async () => {
    selectQueue = [[partnerPolicyRow({ reviewerModel: 'stale-model' } as unknown as Partial<AiScriptPolicyRow>)]];
    const body = await (await getReq()).json();
    expect(body.policy).not.toBeNull();
    expect(body.policy).not.toHaveProperty('reviewerModel');
  });

  it('400s when the body carries unattendedEnabled (strict schema refuses the org grant on a partner row)', async () => {
    const res = await putReq({ unattendedEnabled: true });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(typeof body.error).toBe('string');
    expect(writes).toHaveLength(0);
  });

  it('400s on an out-of-range maxUnattendedRiskTier', async () => {
    const res = await putReq({ maxUnattendedRiskTier: 'high' });
    expect(res.status).toBe(400);
    expect(writes).toHaveLength(0);
  });
});

/**
 * #8112: the web mints the ceiling grant from `partnerScriptCeilingGrantResource`
 * (packages/shared). Round-trip it through the step-up route's own schema and
 * digest (mint side) and this route's consume (redeem side), so the two can
 * never drift apart silently.
 */
describe('mint → redeem round-trip with the shared partner ceiling resource (#8112)', () => {
  const FULL_BODY = {
    proposingEnabled: true,
    maxUnattendedRiskTier: 'medium' as const,
    unattendedAllowedClasses: ['temp_files', 'dns_cache'],
    maxUnattendedPerHour: 7,
    protectedResources: { services: [], paths: ['C:\\Keep'], registryKeys: [], deviceTags: [] },
  };

  function armConsumeFor(resource: unknown) {
    const minted = partnerScriptCeilingStepUpResource.parse(resource);
    const mintDigest = partnerScriptCeilingResourceDigest(minted);
    consumeStepUpGrant.mockImplementation(async (_grantId: string, binding: { operation: string; resourceDigest: string }) =>
      binding.operation === 'ai_partner_script_ceiling_grant' && binding.resourceDigest === mintDigest);
  }

  it('a grant minted for one set of values does not redeem a save of wider ones', async () => {
    armConsumeFor(partnerScriptCeilingGrantResource({ partnerId: PARTNER, allowed: true, saved: null, body: FULL_BODY }));
    const res = await putReq({ ...FULL_BODY, maxUnattendedPerHour: FULL_BODY.maxUnattendedPerHour + 1, unattendedAllowed: true, stepUpGrant: 'grant-1' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Step-up required', code: 'STEP_UP_REQUIRED' });
    expect(writes).toHaveLength(0);
  });

  it('a grant minted for another partner does not redeem', async () => {
    armConsumeFor(partnerScriptCeilingGrantResource({ partnerId: '44444444-4444-4444-8444-444444444444', allowed: true, saved: null, body: FULL_BODY }));
    const res = await putReq({ ...FULL_BODY, unattendedAllowed: true, stepUpGrant: 'grant-1' });
    expect(res.status).toBe(403);
    expect(writes).toHaveLength(0);
  });

  it.each([
    ['first-ever enable (no row yet)', null, FULL_BODY],
    ['enable over an existing disallowed row with different values', partnerPolicyRow({ unattendedAllowed: false, maxUnattendedRiskTier: 'low', maxUnattendedPerHour: 3 }), FULL_BODY],
    ['enable that saves empty protectedResources', partnerPolicyRow({ protectedResources: { services: ['spooler'], paths: [], registryKeys: [], deviceTags: [] } }),
      { ...FULL_BODY, protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] } }],
  ])('enable: %s', async (_label, row, body) => {
    if (row) selectQueue = [[row]];
    const saved = row ? toScriptPolicyDto(row) : null;
    const resource = partnerScriptCeilingGrantResource({
      partnerId: PARTNER,
      allowed: true,
      saved: saved ? { ...saved, unattendedAllowed: saved.unattendedAllowed ?? false } : null,
      body,
    });
    expect(resource).not.toBeNull();
    armConsumeFor(resource);

    const res = await putReq({ ...body, unattendedAllowed: true, stepUpGrant: 'grant-1' });
    expect(res.status).toBe(200);
    expect(consumeStepUpGrant).toHaveBeenCalledTimes(1);
    expect(writes).toHaveLength(1);
  });

  it.each([
    ['raise the tier', {}, { maxUnattendedRiskTier: 'medium' as const }],
    ['add a class', {}, { unattendedAllowedClasses: ['services', 'temp_files'] }],
    ['raise the rate', {}, { maxUnattendedPerHour: 9 }],
    ['turn proposing on', { proposingEnabled: false }, { proposingEnabled: true }],
    ['empty protectedResources', { protectedResources: { services: ['spooler'], paths: [], registryKeys: [], deviceTags: [] } },
      { protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] } }],
  ])('widen an already-allowed ceiling: %s', async (_label, rowOverrides, change) => {
    const row = partnerPolicyRow({ unattendedAllowed: true, ...rowOverrides });
    selectQueue = [[row]];
    const saved = toScriptPolicyDto(row);
    // The page PUTs every field and omits the unchanged `unattendedAllowed`.
    const body = {
      proposingEnabled: saved.proposingEnabled,
      maxUnattendedRiskTier: saved.maxUnattendedRiskTier as 'low' | 'medium',
      unattendedAllowedClasses: saved.unattendedAllowedClasses as string[],
      maxUnattendedPerHour: saved.maxUnattendedPerHour,
      protectedResources: saved.protectedResources,
      ...change,
    };
    const resource = partnerScriptCeilingGrantResource({
      partnerId: PARTNER,
      allowed: true,
      saved: { ...saved, unattendedAllowed: true },
      body,
    });
    expect(resource).not.toBeNull();
    armConsumeFor(resource);

    const res = await putReq({ ...body, stepUpGrant: 'grant-1' });
    expect(res.status).toBe(200);
    expect(consumeStepUpGrant).toHaveBeenCalledTimes(1);
    expect(writes).toHaveLength(1);
  });

  it('a non-widening save of an allowed ceiling needs no grant on either side', async () => {
    const row = partnerPolicyRow({ unattendedAllowed: true, maxUnattendedRiskTier: 'medium', maxUnattendedPerHour: 10 });
    selectQueue = [[row]];
    const saved = toScriptPolicyDto(row);
    const body = {
      proposingEnabled: saved.proposingEnabled,
      maxUnattendedRiskTier: 'low' as const,
      unattendedAllowedClasses: [] as string[],
      maxUnattendedPerHour: 4,
      protectedResources: saved.protectedResources,
    };
    expect(partnerScriptCeilingGrantResource({
      partnerId: PARTNER, allowed: true, saved: { ...saved, unattendedAllowed: true }, body,
    })).toBeNull();

    const res = await putReq(body);
    expect(res.status).toBe(200);
    expect(consumeStepUpGrant).not.toHaveBeenCalled();
  });

  it('disabling needs no grant on either side', async () => {
    const row = partnerPolicyRow({ unattendedAllowed: true });
    selectQueue = [[row]];
    const saved = toScriptPolicyDto(row);
    const body = {
      proposingEnabled: true,
      maxUnattendedRiskTier: 'medium' as const,
      unattendedAllowedClasses: ['services', 'temp_files'],
      maxUnattendedPerHour: 50,
      protectedResources: saved.protectedResources,
    };
    expect(partnerScriptCeilingGrantResource({
      partnerId: PARTNER, allowed: false, saved: { ...saved, unattendedAllowed: true }, body,
    })).toBeNull();

    const res = await putReq({ ...body, unattendedAllowed: false });
    expect(res.status).toBe(200);
    expect(consumeStepUpGrant).not.toHaveBeenCalled();
  });
});
