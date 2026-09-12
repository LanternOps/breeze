import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * Route tests for `partnerAiScriptPolicyRoutes` (#5612 W04): the PARTNER
 * ceiling half of `ai_script_policies`. `requireScope` and
 * `canManagePartnerWidePolicies` are left REAL (no mocking of
 * `../middleware/auth` behaviour or `../services/partnerWideAccess`) so the
 * scope/partner-wide-write gate is genuinely exercised.
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
    ...overrides,
  };
}

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
    reviewerModel: null,
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
    expect(await res.json()).toEqual({ policy: null, canManage: false });
  });

  it('returns the DTO for a queued partner row', async () => {
    selectQueue = [[partnerPolicyRow({ unattendedAllowed: true })]];
    const res = await getReq();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.policy).toEqual(toScriptPolicyDto(partnerPolicyRow({ unattendedAllowed: true })));
    expect(body.policy.ownerScope).toBe('partner');
    expect(body.canManage).toBe(true);
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

  it('200s for a full partner admin and persists the ceiling row', async () => {
    const res = await putReq({ unattendedAllowed: true, maxUnattendedRiskTier: 'medium' });
    expect(res.status).toBe(200);

    expect(writes).toHaveLength(1);
    expect(writes[0].values).toMatchObject({
      partnerId: PARTNER,
      orgId: null,
      unattendedAllowed: true,
      maxUnattendedRiskTier: 'medium',
    });

    expect(auditLog).toHaveLength(1);
    expect(auditLog[0].action).toBe('ai.script_policy.partner_updated');
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
