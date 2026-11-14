import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
  },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  getCurrentDbAccessContext: vi.fn(() => ({ scope: 'system' as const })),
}));

// Field-provenance tiering (denylist option) — see configurationPolicy.baseline.test.ts.
vi.mock('./executionTargetGating', () => ({
  resolveExecutionSafeGroupIds: vi.fn(async (groupIds: string[]) => ({ allowedGroupIds: groupIds, refusedGroups: [] })),
  auditRefusedExecutionGroups: vi.fn(),
}));

import { resolveEffectiveConfig } from './configurationPolicy';
import { db } from '../db';
import type { AuthContext } from '../middleware/auth';

// Thenable chain — every chainable method returns itself; await resolves to rows.
function selectChain(rows: unknown[]) {
  const chain: any = {
    then(resolve: (v: unknown) => void) {
      resolve(rows);
    },
  };
  for (const m of ['from', 'where', 'innerJoin', 'leftJoin', 'orderBy', 'limit']) {
    chain[m] = () => chain;
  }
  return chain;
}

// The resolver issues a 5th select — the authoring-policy name lookup — but ONLY
// when at least one resolved row is inherited. Queueing it unconditionally would
// make the "authored link" cases pass for the wrong reason, so the harness
// mirrors the same condition the implementation uses.
const PARENT_NAMES = [
  { id: 'parent-1', name: 'Baseline' },
  { id: 'parent-2', name: 'Second Baseline' },
];

function mockResolverCalls(assignmentRows: Array<Record<string, unknown>>) {
  const mock = vi
    .mocked(db.select)
    .mockReturnValueOnce(selectChain([DEVICE]) as any) // device
    .mockReturnValueOnce(selectChain([ORG]) as any) // org
    .mockReturnValueOnce(selectChain([]) as any) // group memberships
    .mockReturnValueOnce(selectChain(assignmentRows) as any)
    .mockReturnValue(selectChain([]) as any); // assignments join
  if (assignmentRows.some((r) => r.inherited)) {
    mock.mockReturnValueOnce(selectChain(PARENT_NAMES) as any); // authoring-policy names
  }
}

const DEVICE = {
  id: 'dev-1',
  orgId: 'org-1',
  siteId: 'site-1',
  deviceRole: 'workstation',
  osType: 'windows',
};
const ORG = { partnerId: 'ptr-1' };

const systemAuth = {
  user: { id: 'system', email: 'system', name: 'System', isPlatformAdmin: false },
  token: {} as any,
  partnerId: null,
  orgId: null,
  scope: 'system',
  accessibleOrgIds: null,
  orgCondition: () => undefined,
  canAccessOrg: () => true,
} as unknown as AuthContext;

// One row of the assignments+effective-links join. `policyId` is the ASSIGNED
// policy (which assignment won); `linkSourcePolicyId` is the policy that
// AUTHORED the link, which differs only when the row is inherited.
function row(over: Record<string, unknown>) {
  return {
    assignmentId: 'asg-1',
    assignmentLevel: 'organization',
    assignmentTargetId: 'org-1',
    assignmentPriority: 10,
    assignmentCreatedAt: new Date('2026-01-01T00:00:00Z'),
    policyId: 'child-1',
    policyName: 'A1 Child',
    featureLinkId: 'link-1',
    featureType: 'event_log',
    featurePolicyId: null,
    inlineSettings: { level: 'info' },
    inherited: false,
    linkSourcePolicyId: 'child-1',
    ...over,
  };
}

describe('resolveEffectiveConfig inheritance provenance', () => {
  beforeEach(() => {
    // mockReset, not clearAllMocks: this harness queues a VARIABLE number of
    // `mockReturnValueOnce` chains (4 or 5, depending on whether a name lookup
    // is expected), and a clear does not drain that queue — a leftover chain
    // would be handed to the next test's first query.
    vi.mocked(db.select).mockReset();
  });

  it('an inherited link keeps sourcePolicyId on the ASSIGNED policy and reports inheritedFrom', async () => {
    mockResolverCalls([
      row({
        inherited: true,
        linkSourcePolicyId: 'parent-1',
      }),
    ]);

    const r = await resolveEffectiveConfig('dev-1', systemAuth);
    const f = r!.features.event_log!;

    // The assignment that won is the child's — that is what decided the device
    // gets this feature, and it is what the ownership clamp must key on.
    expect(f.sourcePolicyId).toBe('child-1');
    expect(f.sourcePolicyName).toBe('A1 Child');
    // Provenance names where the settings actually came from.
    expect(f.inheritedFromPolicyId).toBe('parent-1');
    expect(f.inheritedFromPolicyName).toBe('Baseline');
  });

  it('an authored link reports null provenance (never the assigned policy itself)', async () => {
    mockResolverCalls([row({ inherited: false })]);

    const f = (await resolveEffectiveConfig('dev-1', systemAuth))!.features.event_log!;
    expect(f.sourcePolicyId).toBe('child-1');
    expect(f.inheritedFromPolicyId).toBeNull();
    expect(f.inheritedFromPolicyName).toBeNull();
  });

  it('reports provenance per feature: only the inherited one carries it', async () => {
    mockResolverCalls([
      row({
        featureType: 'event_log',
        featureLinkId: 'link-parent-el',
        inherited: true,
        linkSourcePolicyId: 'parent-1',
      }),
      row({ featureType: 'patch', featureLinkId: 'link-child-ar', inherited: false }),
    ]);

    const r = await resolveEffectiveConfig('dev-1', systemAuth);
    expect(r!.features.event_log!.inheritedFromPolicyId).toBe('parent-1');
    expect(r!.features.patch!.inheritedFromPolicyId).toBeNull();
    // Both compete at the CHILD's assignment level and priority.
    expect(r!.features.event_log!.sourceLevel).toBe('organization');
    expect(r!.features.patch!.sourceLevel).toBe('organization');
  });

  it('a lost row does not leak its provenance onto the winner', async () => {
    // Device-level authored link wins over the org-level inherited one.
    mockResolverCalls([
      row({
        assignmentLevel: 'organization',
        inherited: true,
        linkSourcePolicyId: 'parent-1',
      }),
      row({
        assignmentId: 'asg-2',
        assignmentLevel: 'device',
        assignmentTargetId: 'dev-1',
        policyId: 'device-policy',
        policyName: 'Device Override',
        featureLinkId: 'link-2',
        inherited: false,
        linkSourcePolicyId: 'device-policy',
      }),
    ]);

    const f = (await resolveEffectiveConfig('dev-1', systemAuth))!.features.event_log!;
    expect(f.sourcePolicyId).toBe('device-policy');
    expect(f.inheritedFromPolicyId).toBeNull();
  });

  it('an unnameable parent still delivers the feature (name null, not dropped)', async () => {
    // Link visibility and policy-row visibility are separate RLS decisions. If
    // the second one comes up empty the feature must still resolve — dropping it
    // would be a silent config-delivery hole, not a display bug.
    mockResolverCalls([row({ inherited: true, linkSourcePolicyId: 'parent-invisible' })]);

    const f = (await resolveEffectiveConfig('dev-1', systemAuth))!.features.event_log!;
    expect(f.inlineSettings).toEqual({ level: 'info' });
    expect(f.inheritedFromPolicyId).toBe('parent-invisible');
    expect(f.inheritedFromPolicyName).toBeNull();
  });

  it('synthesized baseline features carry null provenance', async () => {
    mockResolverCalls([]);
    const r = await resolveEffectiveConfig('dev-1', systemAuth, { includeBaseline: true });
    expect(r!.features.remote_access!.inheritedFromPolicyId).toBeNull();
    expect(r!.features.remote_access!.inheritedFromPolicyName).toBeNull();
  });
});


it('effective configuration lists additive software policies while maintenance remains closest-wins', async () => {
  vi.mocked(db.select).mockReset();
  mockResolverCalls([
    row({ featureType: 'software_policy', featurePolicyId: 'required', featurePolicyName: 'Required apps', policyId: 'partner', assignmentLevel: 'partner' }),
    row({ featureType: 'software_policy', featurePolicyId: 'blocked', featurePolicyName: 'Blocked apps', policyId: 'org', assignmentLevel: 'organization' }),
    row({ featureType: 'maintenance', policyId: 'partner', assignmentLevel: 'partner' }),
    row({ featureType: 'maintenance', policyId: 'org', assignmentLevel: 'organization' }),
  ]);
  const result = await resolveEffectiveConfig('dev-1', systemAuth);
  expect(result?.softwarePolicies.map((entry) => entry.featurePolicyName)).toEqual(['Blocked apps', 'Required apps']);
  expect(result?.features.maintenance?.sourcePolicyId).toBe('org');
});

it('effective configuration includes explicit org software targets without a configuration link', async () => {
  vi.mocked(db.select).mockReset();
  mockResolverCalls([]);
  vi.mocked(db.select).mockReturnValue(selectChain([
    { id: 'default-blocklist', name: 'Default Blocklist', targetType: 'organization', targetIds: ['org-1'], priority: 10 },
  ]) as any);
  const result = await resolveEffectiveConfig('dev-1', systemAuth, { includeBaseline: true });
  expect(result?.softwarePolicies).toEqual([expect.objectContaining({
    featurePolicyId: 'default-blocklist', featurePolicyName: 'Default Blocklist', sourceKind: 'software_policy',
  })]);
  expect(result?.features.software_policy?.featurePolicyId).toBe('default-blocklist');
  expect(result?.features.software_policy?.sourceLevel).not.toBe('default');
  expect(result?.inheritanceChain).toEqual([expect.objectContaining({
    level: 'default', featureTypes: expect.not.arrayContaining(['software_policy']),
  })]);
});

it('effective configuration omits disabled software links while retaining other feature types', async () => {
  vi.mocked(db.select).mockReset();
  mockResolverCalls([
    row({ featureType: 'software_policy', featurePolicyId: 'disabled', softwarePolicyActive: false }),
    row({ featureType: 'software_policy', featurePolicyId: 'missing', softwarePolicyActive: null }),
    row({ featureType: 'software_policy', featurePolicyId: 'active', softwarePolicyActive: true, policyId: 'active-config' }),
    row({ featureType: 'maintenance', softwarePolicyActive: null }),
  ]);
  const result = await resolveEffectiveConfig('dev-1', systemAuth);
  expect(result?.softwarePolicies.map((p) => p.featurePolicyId)).toEqual(['active']);
  expect(result?.features.software_policy?.featurePolicyId).toBe('active');
  expect(result?.features.maintenance).toBeDefined();
  expect(result?.inheritanceChain.every((entry) => entry.policyId !== 'child-1' || !entry.featureTypes.includes('software_policy'))).toBe(true);
});
