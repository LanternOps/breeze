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
const resolvePartnerCeiling = vi.fn();
vi.mock('../../services/scriptProposals/policy', () => ({
  resolveEffectiveScriptPolicy: (...a: unknown[]) => resolveEffectiveScriptPolicy(...a),
  resolvePartnerCeiling: (...a: unknown[]) => resolvePartnerCeiling(...a),
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
import { scriptLaneStepUpResource } from '../auth/schemas';
import { scriptLaneEnableGrantResource, scriptLaneWideningGrantResource } from '@breeze/shared';
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
  resolvePartnerCeiling.mockResolvedValue(DEFAULT_EFFECTIVE);
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

  it('403s MFA_REQUIRED when the MFA claim is false, even for a non-widening save', async () => {
    currentAuth = orgAuth({ token: { mfa: false, sid: 'sid-1' } });
    const res = await putReq({ proposingEnabled: true });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'MFA required', code: 'MFA_REQUIRED' });
  });

  it('403s a site-restricted caller with SITE_CEILING_WRITE_DENIED_MESSAGE', async () => {
    currentAuth = orgAuth({ allowedSiteIds: ['site-1'] });
    const res = await putReq({ proposingEnabled: true });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/Site-restricted users cannot modify organization-wide settings/);
  });

  it('403s an exact-device-ceiled caller (allowedDeviceIds set, no allowedSiteIds)', async () => {
    currentAuth = orgAuth({ allowedDeviceIds: [] });
    const res = await putReq({ proposingEnabled: true });
    expect(res.status).toBe(403);
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

  it('422s above_partner_ceiling when a class exceeds the PARTNER allowlist', async () => {
    resolvePartnerCeiling.mockResolvedValue({ ...DEFAULT_EFFECTIVE, unattendedAllowedClasses: ['services'] });
    const res = await putReq({ unattendedAllowedClasses: ['services', 'processes'] });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'above_partner_ceiling', field: 'unattendedAllowedClasses' });
  });

  it('422s when maxUnattendedRiskTier exceeds the PARTNER ceiling', async () => {
    resolvePartnerCeiling.mockResolvedValue({ ...DEFAULT_EFFECTIVE, maxUnattendedRiskTier: 'low' });
    const res = await putReq({ maxUnattendedRiskTier: 'medium' });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'above_partner_ceiling', field: 'maxUnattendedRiskTier' });
  });

  it('422s when maxUnattendedPerHour exceeds the PARTNER ceiling', async () => {
    resolvePartnerCeiling.mockResolvedValue({ ...DEFAULT_EFFECTIVE, maxUnattendedPerHour: 5 });
    const res = await putReq({ maxUnattendedPerHour: 10 });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'above_partner_ceiling', field: 'maxUnattendedPerHour' });
  });

  it('REGRESSION: an org that lowered a value can raise it back inside the partner ceiling (no ratchet)', async () => {
    // The org's own current row (per-hour 3) is folded into the EFFECTIVE
    // merge; the write check must consult the PARTNER ceiling (10) instead.
    resolveEffectiveScriptPolicy.mockResolvedValue({ ...DEFAULT_EFFECTIVE, maxUnattendedPerHour: 3, unattendedAllowedClasses: ['services'], maxUnattendedRiskTier: 'low' });
    resolvePartnerCeiling.mockResolvedValue({ ...DEFAULT_EFFECTIVE, maxUnattendedPerHour: 10, unattendedAllowedClasses: ['services', 'processes'], maxUnattendedRiskTier: 'medium' });
    const res = await putReq({ maxUnattendedPerHour: 7, unattendedAllowedClasses: ['services', 'processes'], maxUnattendedRiskTier: 'medium' });
    expect(res.status).toBe(200);
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
    // The enable-branch digest binds the FULL effective grant being saved in
    // this request, not just the boolean — a request that also raises the
    // tier/classes/rate in the same call must have those
    // values bound in, so a grant minted only for "turn the lane on" cannot
    // be replayed against a wider save.
    expect(binding.resourceDigest).toBe(scriptLanePolicyResourceDigest({
      orgId: ORG_A,
      unattendedEnabled: true,
      widening: {
        maxUnattendedRiskTier: 'low',
        unattendedAllowedClasses: [],
        maxUnattendedPerHour: 0,
        protectedResourcesEmptied: true,
        proposingEnabled: true,
      },
    }));

    expect(writes).toHaveLength(1);
    expect(writes[0]!.values).toMatchObject({ unattendedEnabled: true, unattendedEnabledBy: USER_ID });
    expect(writes[0]!.values.unattendedEnabledAt).toBeInstanceOf(Date);

    expect(auditLog).toHaveLength(1);
    expect(auditLog[0]!.action).toBe('ai.script_lane.enabled');
  });

  it('a step-up grant minted for a narrow "turn on" cannot be replayed to enable at a wider tier in the same call', async () => {
    // Mint a grant bound to the digest for a BARE enable (no widening — what
    // an operator's MFA ceremony would have shown for "just turn this on").
    // Redeeming it against a PUT that simultaneously sets the tier to
    // 'medium' must fail: the digest this route computes for that PUT now
    // includes the tier, so it will not match a grant bound to the narrow
    // digest.
    resolvePartnerCeiling.mockResolvedValue({ ...DEFAULT_EFFECTIVE, maxUnattendedRiskTier: 'medium' });
    consumeStepUpGrant.mockImplementation(async (_grantId: string, binding: { resourceDigest: string }) =>
      binding.resourceDigest === scriptLanePolicyResourceDigest({ orgId: ORG_A, unattendedEnabled: true }));
    const res = await putReq({ unattendedEnabled: true, maxUnattendedRiskTier: 'medium', stepUpGrant: 'grant-1' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Step-up required', code: 'STEP_UP_REQUIRED' });
    expect(writes).toHaveLength(0);
  });

  it.each([
    ['first-ever enable (no row yet)', false, ['C:\\Keep']],
    ['re-enable over an existing row with different values', true, ['C:\\Keep']],
    ['re-enable that empties protectedResources', true, []],
  ])('round-trips the shared enable-grant resource: mint digest === redeem digest (#7873) — %s', async (_label, hasRow, paths) => {
    resolvePartnerCeiling.mockResolvedValue({ ...DEFAULT_EFFECTIVE, maxUnattendedRiskTier: 'medium' });
    if (hasRow) {
      selectQueue = [[policyRow({
        unattendedEnabled: false,
        maxUnattendedRiskTier: 'low',
        unattendedAllowedClasses: ['services'],
        maxUnattendedPerHour: 5,
        protectedResources: { services: ['spooler'], paths: [], registryKeys: [], deviceTags: [] },
      })]];
    }
    // The exact body shape the web page PUTs (every field present).
    const saveBody = {
      proposingEnabled: true,
      unattendedEnabled: true,
      maxUnattendedRiskTier: 'medium' as const,
      unattendedAllowedClasses: ['temp_files', 'dns_cache'],
      maxUnattendedPerHour: 7,
      protectedResources: { services: [], paths, registryKeys: [], deviceTags: [] },
    };
    // Mint side: the resource the web sends to /auth/mfa/step-up, parsed by
    // the step-up route's schema and hashed exactly as that route hashes it.
    const minted = scriptLaneStepUpResource.parse(scriptLaneEnableGrantResource(ORG_A, saveBody));
    const mintDigest = scriptLanePolicyResourceDigest(minted);
    consumeStepUpGrant.mockImplementation(async (_grantId: string, binding: { resourceDigest: string }) =>
      binding.resourceDigest === mintDigest);

    const res = await putReq({ ...saveBody, stepUpGrant: 'grant-1' });
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
  ])('round-trips the shared WIDENING grant resource: mint digest === redeem digest (#8096) — %s', async (_label, rowOverrides, change) => {
    resolvePartnerCeiling.mockResolvedValue({ ...DEFAULT_EFFECTIVE, maxUnattendedRiskTier: 'medium' });
    const row = policyRow({
      unattendedEnabled: true,
      maxUnattendedRiskTier: 'low',
      unattendedAllowedClasses: ['services'],
      maxUnattendedPerHour: 5,
      ...rowOverrides,
    });
    selectQueue = [[row]];
    const saved = toScriptPolicyDto(row);
    // What the web PUTs for an already-enabled lane: every field, and no
    // `unattendedEnabled` (an unchanged `true` would read as the enable branch).
    const saveBody = {
      proposingEnabled: saved.proposingEnabled,
      maxUnattendedRiskTier: saved.maxUnattendedRiskTier as 'low' | 'medium',
      unattendedAllowedClasses: saved.unattendedAllowedClasses as string[],
      maxUnattendedPerHour: saved.maxUnattendedPerHour,
      protectedResources: saved.protectedResources,
      ...change,
    };
    const resource = scriptLaneWideningGrantResource(ORG_A, saved, saveBody);
    expect(resource).not.toBeNull();
    const mintDigest = scriptLanePolicyResourceDigest(scriptLaneStepUpResource.parse(resource));
    consumeStepUpGrant.mockImplementation(async (_grantId: string, binding: { operation: string; resourceDigest: string }) =>
      binding.operation === 'ai_script_lane_grant' && binding.resourceDigest === mintDigest);

    const res = await putReq({ ...saveBody, stepUpGrant: 'grant-1' });
    expect(res.status).toBe(200);
    expect(consumeStepUpGrant).toHaveBeenCalledTimes(1);
    expect(writes).toHaveLength(1);
  });

  it('the shared widening resource is null for a tightening save, and the route asks for no grant (#8096)', async () => {
    const row = policyRow({ unattendedEnabled: true, maxUnattendedRiskTier: 'low', unattendedAllowedClasses: ['services', 'temp_files'], maxUnattendedPerHour: 5 });
    selectQueue = [[row]];
    const saved = toScriptPolicyDto(row);
    const saveBody = {
      proposingEnabled: saved.proposingEnabled,
      maxUnattendedRiskTier: 'low' as const,
      unattendedAllowedClasses: ['services'],
      maxUnattendedPerHour: 2,
      protectedResources: saved.protectedResources,
    };
    expect(scriptLaneWideningGrantResource(ORG_A, saved, saveBody)).toBeNull();
    const res = await putReq(saveBody);
    expect(res.status).toBe(200);
    expect(consumeStepUpGrant).not.toHaveBeenCalled();
  });

  it('200s disabling without approvals:decide or a step-up grant, and audits ai.script_policy.updated', async () => {
    currentPerms = makePerms([PERMISSIONS.AI_AGENTS_WRITE]);
    const res = await putReq({ unattendedEnabled: false });
    expect(res.status).toBe(200);
    expect(consumeStepUpGrant).not.toHaveBeenCalled();
    expect(auditLog).toHaveLength(1);
    expect(auditLog[0]!.action).toBe('ai.script_policy.updated');
  });

  it('strips stepUpGrant from the persisted columns', async () => {
    const res = await putReq({ proposingEnabled: true, stepUpGrant: 'unused-grant' });
    expect(res.status).toBe(200);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.values).not.toHaveProperty('stepUpGrant');
    expect(writes[0]!.set).not.toHaveProperty('stepUpGrant');
  });

  it('requires a step-up grant to WIDEN an already-enabled lane (raise the risk tier)', async () => {
    resolvePartnerCeiling.mockResolvedValue({ ...DEFAULT_EFFECTIVE, maxUnattendedRiskTier: 'medium' });
    selectQueue = [[policyRow({ unattendedEnabled: true, maxUnattendedRiskTier: 'low' })]];
    const res = await putReq({ maxUnattendedRiskTier: 'medium' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Step-up required', code: 'STEP_UP_REQUIRED' });
    expect(writes).toHaveLength(0);
  });

  it('200s WIDENING an already-enabled lane with a consumed step-up grant bound to the wider values', async () => {
    resolvePartnerCeiling.mockResolvedValue({ ...DEFAULT_EFFECTIVE, maxUnattendedRiskTier: 'medium' });
    selectQueue = [[policyRow({ unattendedEnabled: true, maxUnattendedRiskTier: 'low', unattendedAllowedClasses: ['services'], maxUnattendedPerHour: 5 })]];
    const res = await putReq({ maxUnattendedRiskTier: 'medium', stepUpGrant: 'grant-1' });
    expect(res.status).toBe(200);

    const [, binding] = consumeStepUpGrant.mock.calls[0] as [string, { resourceDigest: string }];
    expect(binding.resourceDigest).toBe(scriptLanePolicyResourceDigest({
      orgId: ORG_A,
      unattendedEnabled: true,
      widening: {
        maxUnattendedRiskTier: 'medium',
        unattendedAllowedClasses: ['services'],
        maxUnattendedPerHour: 5,
        protectedResourcesEmptied: false,
        proposingEnabled: true,
      },
    }));
  });

  it('requires a step-up grant to WIDEN by emptying a previously non-empty protectedResources', async () => {
    selectQueue = [[policyRow({ unattendedEnabled: true, protectedResources: { services: ['spooler'], paths: [], registryKeys: [], deviceTags: [] } })]];
    const res = await putReq({ protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] } });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Step-up required', code: 'STEP_UP_REQUIRED' });
  });

  it('does not require a step-up grant when an already-enabled lane is only tightened', async () => {
    selectQueue = [[policyRow({ unattendedEnabled: true, maxUnattendedRiskTier: 'medium', maxUnattendedPerHour: 10 })]];
    const res = await putReq({ maxUnattendedPerHour: 3 });
    expect(res.status).toBe(200);
    expect(consumeStepUpGrant).not.toHaveBeenCalled();
  });

  it('PUT /ai/script-policy with reviewerModel → 400 naming the replacement; nothing is written', async () => {
    for (const reviewerModel of ['claude-x', null]) {
      selectQueue = [[policyRow({ unattendedEnabled: true })]];
      const res = await putReq({ proposingEnabled: false, reviewerModel });
      expect(res.status).toBe(400);
      const text = JSON.stringify(await res.json());
      expect(text).toContain('reviewerModel');
      expect(text).toContain('script_reviewer');
    }
    expect(consumeStepUpGrant).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
    expect(auditLog).toHaveLength(0);
  });

  it('GET /ai/script-policy no longer returns reviewerModel', async () => {
    selectQueue = [[policyRow({ reviewerModel: 'stale-model' } as unknown as Partial<AiScriptPolicyRow>)], [laneRow()]];
    const body = await (await getReq()).json();
    expect(body.policy).not.toBeNull();
    expect(body.policy).not.toHaveProperty('reviewerModel');
  });

  it('does not require a step-up grant to disable an enabled lane even if other fields also change', async () => {
    currentPerms = makePerms([PERMISSIONS.AI_AGENTS_WRITE]);
    resolvePartnerCeiling.mockResolvedValue({ ...DEFAULT_EFFECTIVE, maxUnattendedRiskTier: 'medium' });
    selectQueue = [[policyRow({ unattendedEnabled: true, maxUnattendedRiskTier: 'low' })]];
    const res = await putReq({ unattendedEnabled: false, maxUnattendedRiskTier: 'medium' });
    expect(res.status).toBe(200);
    expect(consumeStepUpGrant).not.toHaveBeenCalled();
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
    expect(writes[0]!.set).toMatchObject({
      state: 'closed',
      consecutiveFailedVerifications: 0,
      openedAt: null,
      resetByUserId: USER_ID,
    });

    expect(auditLog).toHaveLength(1);
    expect(auditLog[0]!.action).toBe('ai.script_lane.reset');
  });
});
