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

// Field-provenance tiering: a refused device_group must still be honored for a
// PROTECTIVE feature type (hardening/monitoring/etc — restricts/detects only)
// and only excluded for an EXECUTION_GATED feature type (installs, runs code,
// grants access) assigned at that same group. See filterEngine.ts's field
// classification and executionTargetGating.ts.
const mockResolveExecutionSafeGroupIds = vi.fn(async (groupIds: string[]) => ({
  allowedGroupIds: [] as string[],
  refusedGroups: groupIds.map((id) => ({ id, refusedFields: ['hostname'] })),
}));
const mockAuditRefusedExecutionGroups = vi.fn();
vi.mock('./executionTargetGating', () => ({
  resolveExecutionSafeGroupIds: (...args: [string[]]) => mockResolveExecutionSafeGroupIds(...args),
  auditRefusedExecutionGroups: (...args: unknown[]) => mockAuditRefusedExecutionGroups(...args),
}));

import { resolveEffectiveConfig } from './configurationPolicy';
import { db } from '../db';
import type { AuthContext } from '../middleware/auth';

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

const DEVICE = { id: 'dev-1', orgId: 'org-1', siteId: 'site-1', deviceRole: 'workstation', osType: 'windows' };
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

function assignmentRow(over: Record<string, unknown>) {
  return {
    assignmentId: 'asg-grp',
    assignmentLevel: 'device_group',
    assignmentTargetId: 'grp-1',
    assignmentPriority: 10,
    assignmentCreatedAt: new Date('2026-01-01T00:00:00Z'),
    policyId: 'grp-policy',
    policyName: 'Group Policy',
    featureLinkId: 'link-1',
    featurePolicyId: null,
    inlineSettings: { on: true },
    inherited: false,
    linkSourcePolicyId: 'grp-policy',
    ...over,
  };
}

describe('resolveEffectiveConfig — refused device_group tiering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveExecutionSafeGroupIds.mockImplementation(async (groupIds: string[]) => ({
      allowedGroupIds: [],
      refusedGroups: groupIds.map((id) => ({ id, refusedFields: ['hostname'] })),
    }));
  });

  it('still applies a PROTECTIVE feature type assignment from a refused group (hardening must not silently drop)', async () => {
    mockResolverCalls(
      [DEVICE],
      [ORG],
      [{ groupId: 'grp-1' }],
      [assignmentRow({ featureType: 'security', featureLinkId: 'link-security' })],
    );

    const r = await resolveEffectiveConfig('dev-1', systemAuth);

    expect(r!.features.security).toBeDefined();
    expect(r!.features.security!.sourceLevel).toBe('device_group');
    expect(r!.features.security!.sourceTargetId).toBe('grp-1');
  });

  it('drops an EXECUTION_GATED feature type assignment from a refused group (falls back to no grant)', async () => {
    mockResolverCalls(
      [DEVICE],
      [ORG],
      [{ groupId: 'grp-1' }],
      [assignmentRow({ featureType: 'automation', featureLinkId: 'link-automation' })],
    );

    const r = await resolveEffectiveConfig('dev-1', systemAuth);

    expect(r!.features.automation).toBeUndefined();
  });

  it('applies protective and drops execution_gated in the same resolve pass, from the same refused group', async () => {
    mockResolverCalls(
      [DEVICE],
      [ORG],
      [{ groupId: 'grp-1' }],
      [
        assignmentRow({ featureType: 'security', featureLinkId: 'link-security' }),
        assignmentRow({ featureType: 'pam', featureLinkId: 'link-pam' }),
      ],
    );

    const r = await resolveEffectiveConfig('dev-1', systemAuth);

    expect(r!.features.security).toBeDefined();
    expect(r!.features.pam).toBeUndefined();
  });

  // Patch and backup are protective (ring/schedule
  // metadata and a profile/destination reference respectively — neither
  // delivers a credential), so a legitimate hostname- or tag-keyed group
  // must still receive them even when the group itself is refused as an
  // execution target.
  it('still applies a patch assignment from a refused group (a legitimate hostname-keyed patch ring must keep patching)', async () => {
    mockResolverCalls(
      [DEVICE],
      [ORG],
      [{ groupId: 'grp-1' }],
      [assignmentRow({ featureType: 'patch', featureLinkId: 'link-patch' })],
    );

    const r = await resolveEffectiveConfig('dev-1', systemAuth);

    expect(r!.features.patch).toBeDefined();
    expect(r!.features.patch!.sourceLevel).toBe('device_group');
  });

  it('still applies a backup assignment from a refused group (a legitimate hostname-keyed backup group must keep backing up)', async () => {
    mockResolverCalls(
      [DEVICE],
      [ORG],
      [{ groupId: 'grp-1' }],
      [assignmentRow({ featureType: 'backup', featureLinkId: 'link-backup' })],
    );

    const r = await resolveEffectiveConfig('dev-1', systemAuth);

    expect(r!.features.backup).toBeDefined();
    expect(r!.features.backup!.sourceLevel).toBe('device_group');
  });

  it('drops a remote_access assignment from a refused group (session grant, not merely protective)', async () => {
    mockResolverCalls(
      [DEVICE],
      [ORG],
      [{ groupId: 'grp-1' }],
      [assignmentRow({ featureType: 'remote_access', featureLinkId: 'link-remote-access' })],
    );

    const r = await resolveEffectiveConfig('dev-1', systemAuth);

    expect(r!.features.remote_access).toBeUndefined();
  });
});
