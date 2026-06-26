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
}));

import { resolveEffectiveConfig } from './configurationPolicy';
import { db } from '../db';
import type { AuthContext } from '../middleware/auth';

// Thenable chain — every chainable method returns itself; await resolves to rows.
// This satisfies all four DB query shapes the resolver uses:
//   select().from().where().limit()              (device + org)
//   select().from().where()                      (group memberships)
//   select().from().innerJoin().innerJoin().where().orderBy()  (assignments join)
function selectChain(rows: unknown[]) {
  const chain: any = {
    then(resolve: (v: unknown) => void) {
      resolve(rows);
    },
  };
  for (const m of ['from', 'where', 'innerJoin', 'orderBy', 'limit']) {
    chain[m] = () => chain;
  }
  return chain;
}

// The resolver makes 4 db.select() calls in order:
//   1. device row        (devices table, limit 1)
//   2. org row           (organizations table, limit 1)
//   3. group memberships (deviceGroupMemberships, no limit)
//   4. assignments join  (configPolicyAssignments + innerJoins + orderBy)
function mockResolverCalls(
  deviceRows: unknown[],
  orgRows: unknown[],
  groupRows: unknown[],
  assignmentRows: unknown[],
) {
  vi.mocked(db.select)
    .mockReturnValueOnce(selectChain(deviceRows) as any)
    .mockReturnValueOnce(selectChain(orgRows) as any)
    .mockReturnValueOnce(selectChain(groupRows) as any)
    .mockReturnValueOnce(selectChain(assignmentRows) as any);
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

describe('resolveEffectiveConfig includeBaseline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('omits baseline by default (features empty for unassigned device)', async () => {
    mockResolverCalls([DEVICE], [ORG], [], []);
    const r = await resolveEffectiveConfig('dev-1', systemAuth);
    expect(r).not.toBeNull();
    expect(Object.keys(r!.features)).toHaveLength(0);
    expect(r!.inheritanceChain).toHaveLength(0);
  });

  it('synthesizes the default layer when includeBaseline is true', async () => {
    mockResolverCalls([DEVICE], [ORG], [], []);
    const r = await resolveEffectiveConfig('dev-1', systemAuth, { includeBaseline: true });
    expect(r).not.toBeNull();
    const ra = r!.features.remote_access!;
    expect(ra.sourceLevel).toBe('default');
    expect(ra.sourcePolicyName).toBe('Breeze Defaults');
    expect((ra.inlineSettings as Record<string, unknown>).webrtcDesktop).toBe(true);
    expect(r!.features.patch!.sourceLevel).toBe('default');
    expect(r!.features.patch!.inlineSettings).toBeNull();

    // Full sentinel assertions on a synthesized feature.
    expect(ra.sourcePolicyId).toBe('breeze-defaults');
    expect(ra.sourceTargetId).toBe('breeze-defaults');
    expect(ra.sourcePriority).toBe(0);
    expect(ra.featurePolicyId).toBeNull();

    const defaultNode = r!.inheritanceChain.find((n) => n.level === 'default');
    expect(defaultNode).toBeTruthy();
    expect(defaultNode!.policyName).toBe('Breeze Defaults');
    expect(defaultNode!.policyId).toBe('breeze-defaults');
    expect(defaultNode!.targetId).toBe('breeze-defaults');
    expect(defaultNode!.priority).toBe(0);
    expect(defaultNode!.featureTypes).toContain('remote_access');
    expect(defaultNode!.featureTypes).toContain('patch');
  });

  it('a real winning assignment blocks baseline synthesis for that feature type', async () => {
    // One real, active org-level remote_access assignment wins; every other
    // feature type still falls through to the synthesized baseline.
    const realAssignmentRow = {
      assignmentId: 'asg-1',
      assignmentLevel: 'organization',
      assignmentTargetId: 'org-1',
      assignmentPriority: 10,
      assignmentCreatedAt: new Date('2026-01-01T00:00:00Z'),
      policyId: 'real-policy-1',
      policyName: 'Org Remote Access Policy',
      featureLinkId: 'link-1',
      featureType: 'remote_access',
      featurePolicyId: null,
      inlineSettings: { sessionPromptMode: 'consent' },
    };
    mockResolverCalls([DEVICE], [ORG], [], [realAssignmentRow]);

    const r = await resolveEffectiveConfig('dev-1', systemAuth, { includeBaseline: true });
    expect(r).not.toBeNull();

    // remote_access resolves from the real policy, not the baseline.
    const ra = r!.features.remote_access!;
    expect(ra.sourceLevel).not.toBe('default');
    expect(ra.sourceLevel).toBe('organization');
    expect(ra.sourcePolicyName).toBe('Org Remote Access Policy');
    expect(ra.sourcePolicyId).toBe('real-policy-1');

    // A still-unconfigured type falls through to the baseline.
    expect(r!.features.patch!.sourceLevel).toBe('default');

    // The default inheritance node must NOT claim remote_access.
    const defaultNode = r!.inheritanceChain.find((n) => n.level === 'default');
    expect(defaultNode).toBeTruthy();
    expect(defaultNode!.featureTypes).not.toContain('remote_access');
    expect(defaultNode!.featureTypes).toContain('patch');
  });
});
