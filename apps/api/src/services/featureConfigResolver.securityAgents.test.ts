import { describe, it, expect, vi, beforeEach } from 'vitest';

// Query-shape unit test for the #6960 resolution dimension. The behaviour across
// several devices (closest wins, inheritance, opt-out, no shadowing) is pinned
// against real Postgres in
// __tests__/integration/securityAgentsResolution.integration.test.ts; this file
// pins the branch selection and the winner comparison without a database.
vi.mock('../db', () => ({
  db: { select: vi.fn() },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  getCurrentDbAccessContext: vi.fn(() => ({ scope: 'system' as const })),
}));

vi.mock('./executionTargetGating', () => ({
  resolveExecutionSafeGroupIds: vi.fn(async (ids: string[]) => ({ allowedGroupIds: ids, refusedGroups: [] })),
}));

import { db } from '../db';
import { resolveExecutionSafeGroupIds } from './executionTargetGating';
import { configPolicyEffectiveFeatureLinks, softwarePolicies } from '../db/schema';
import {
  resolveDeviceIdsForSoftwarePolicy,
  resolveSecurityAgentsLinkForDevice,
  resolveSecurityAgentsLinksForDevices,
} from './featureConfigResolver';

let fromTables: unknown[];

function chain(rows: unknown[]) {
  const c: any = { then: (resolve: (v: unknown) => void) => resolve(rows) };
  for (const m of ['where', 'orderBy', 'limit', 'groupBy', 'innerJoin', 'leftJoin']) c[m] = () => c;
  c.from = (table: unknown) => {
    fromTables.push(table);
    return c;
  };
  return c;
}

function queue(...rowSets: unknown[][]) {
  for (const rows of rowSets) vi.mocked(db.select).mockReturnValueOnce(chain(rows) as any);
}

const DEVICE = { id: 'dev-1', orgId: 'org-1', siteId: 'site-1', deviceRole: 'workstation', osType: 'windows' };
const HIERARCHY = [[DEVICE], [{ partnerId: 'ptr-1' }], []];
const SETTINGS = { version: 1, agents: [{ vendor: 'huntress', enabled: false }] };

function winnerRow(linkId: string, inlineSettings: unknown = SETTINGS) {
  return {
    linkId,
    sourcePolicyId: 'cp-owner',
    inlineSettings,
    assignedPolicyId: 'cp-assigned',
    assignmentLevel: 'device',
    assignmentPriority: 0,
    assignmentCreatedAt: new Date(0),
    assignmentId: 'asg-1',
  };
}

beforeEach(() => {
  vi.mocked(db.select).mockReset();
  fromTables = [];
});

describe('resolveSecurityAgentsLinkForDevice (#6960)', () => {
  it('returns the winning link, its owning policy and the parsed settings', async () => {
    queue(...HIERARCHY, [winnerRow('link-1')]);
    await expect(resolveSecurityAgentsLinkForDevice('dev-1')).resolves.toEqual({
      linkId: 'link-1',
      configPolicyId: 'cp-owner',
      assignedPolicyId: 'cp-assigned',
      inlineSettings: SETTINGS,
    });
  });

  it('targets only execution-safe device groups (security_agents is execution_gated)', async () => {
    queue([DEVICE], [{ partnerId: 'ptr-1' }], [{ groupId: 'grp-self-reported' }], []);
    vi.mocked(resolveExecutionSafeGroupIds).mockResolvedValueOnce({
      allowedGroupIds: [],
      refusedGroups: [{ id: 'grp-self-reported', refusedFields: ['hostname'] }],
    });
    await resolveSecurityAgentsLinkForDevice('dev-1');
    expect(resolveExecutionSafeGroupIds).toHaveBeenCalledWith(['grp-self-reported']);
  });

  it('returns null when no security_agents link reaches the device', async () => {
    queue(...HIERARCHY, []);
    await expect(resolveSecurityAgentsLinkForDevice('dev-1')).resolves.toBeNull();
  });

  it('resolves an unparseable stored blob as no agents (install nothing)', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    queue(...HIERARCHY, [winnerRow('link-1', { version: 1, agents: [{ vendor: 'huntress', enabled: true, apiKey: 'x' }] })]);
    const r = await resolveSecurityAgentsLinkForDevice('dev-1');
    expect(r?.inlineSettings).toEqual({ version: 1, agents: [] });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

/** One candidate row of the batched resolver's single assignment query. */
function candidate(linkId: string, level: string, targetId: string, extra: Record<string, unknown> = {}) {
  return {
    linkId,
    policyOrgId: null,
    policyPartnerId: 'ptr-1',
    assignmentLevel: level,
    assignmentTargetId: targetId,
    assignmentPriority: 0,
    assignmentCreatedAt: new Date(0),
    roleFilter: null,
    osFilter: null,
    ...extra,
  };
}

function devices(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `dev-${i + 1}`, orgId: 'org-1', siteId: 'site-1', deviceRole: 'workstation', osType: 'windows',
  }));
}

describe('resolveSecurityAgentsLinksForDevices — batched (#6960 W02)', () => {
  it('a fixed number of queries whatever the device count (no per-device N+1)', async () => {
    const many = devices(40);
    queue(many, [{ id: 'org-1', partnerId: 'ptr-1', type: 'customer' }], [], [candidate('link-1', 'partner', 'ptr-1')]);
    const winners = await resolveSecurityAgentsLinksForDevices(many.map((d) => d.id));
    expect(vi.mocked(db.select)).toHaveBeenCalledTimes(4);
    expect(winners.size).toBe(40);
    expect(winners.get('dev-40')).toBe('link-1');
  });

  it('closest wins: a device-level link beats a partner-level one', async () => {
    queue(devices(2), [{ id: 'org-1', partnerId: 'ptr-1', type: 'customer' }], [], [
      candidate('link-partner', 'partner', 'ptr-1'),
      candidate('link-optout', 'device', 'dev-2'),
    ]);
    const winners = await resolveSecurityAgentsLinksForDevices(['dev-1', 'dev-2']);
    expect(winners.get('dev-1')).toBe('link-partner');
    expect(winners.get('dev-2')).toBe('link-optout');
  });

  it('same level: lower priority number wins, then the earlier assignment', async () => {
    queue(devices(1), [{ id: 'org-1', partnerId: 'ptr-1', type: 'customer' }], [], [
      candidate('link-late', 'organization', 'org-1', { assignmentPriority: 5, assignmentCreatedAt: new Date(10) }),
      candidate('link-b', 'organization', 'org-1', { assignmentPriority: 1, assignmentCreatedAt: new Date(20) }),
      candidate('link-a', 'organization', 'org-1', { assignmentPriority: 1, assignmentCreatedAt: new Date(5) }),
    ]);
    expect((await resolveSecurityAgentsLinksForDevices(['dev-1'])).get('dev-1')).toBe('link-a');
  });

  it("a partner-wide policy does not reach a device whose org is the partner's holding pool", async () => {
    queue(devices(1), [{ id: 'org-1', partnerId: 'ptr-1', type: 'unassigned_pool' }], [], [
      candidate('link-partner', 'partner', 'ptr-1'),
      candidate('link-wide-org', 'organization', 'org-1'),
    ]);
    expect((await resolveSecurityAgentsLinksForDevices(['dev-1'])).get('dev-1')).toBeNull();
  });

  it("an org-owned policy reaches only its own org's devices", async () => {
    queue(
      [{ id: 'dev-1', orgId: 'org-1', siteId: 's1', deviceRole: 'workstation', osType: 'windows' },
        { id: 'dev-2', orgId: 'org-2', siteId: 's2', deviceRole: 'workstation', osType: 'windows' }],
      [{ id: 'org-1', partnerId: 'ptr-1', type: 'customer' }, { id: 'org-2', partnerId: 'ptr-1', type: 'customer' }],
      [],
      [candidate('link-org1', 'partner', 'ptr-1', { policyOrgId: 'org-1', policyPartnerId: null })],
    );
    const winners = await resolveSecurityAgentsLinksForDevices(['dev-1', 'dev-2']);
    expect(winners.get('dev-1')).toBe('link-org1');
    expect(winners.get('dev-2')).toBeNull();
  });

  it('role and OS filters apply', async () => {
    queue(devices(1), [{ id: 'org-1', partnerId: 'ptr-1', type: 'customer' }], [], [
      candidate('link-servers', 'device', 'dev-1', { roleFilter: ['server'] }),
      candidate('link-mac', 'site', 'site-1', { osFilter: ['macos'] }),
      candidate('link-org', 'organization', 'org-1'),
    ]);
    expect((await resolveSecurityAgentsLinksForDevices(['dev-1'])).get('dev-1')).toBe('link-org');
  });

  it('only execution-safe device groups are targets (execution_gated)', async () => {
    queue(devices(1), [{ id: 'org-1', partnerId: 'ptr-1', type: 'customer' }], [{ deviceId: 'dev-1', groupId: 'grp-unsafe' }], [
      candidate('link-group', 'device_group', 'grp-unsafe'),
      candidate('link-org', 'organization', 'org-1'),
    ]);
    vi.mocked(resolveExecutionSafeGroupIds).mockResolvedValueOnce({
      allowedGroupIds: [],
      refusedGroups: [{ id: 'grp-unsafe', refusedFields: ['hostname'] }],
    } as never);
    expect((await resolveSecurityAgentsLinksForDevices(['dev-1'])).get('dev-1')).toBe('link-org');
  });

  it('an unknown device resolves to null', async () => {
    queue([], [], [], []);
    expect((await resolveSecurityAgentsLinksForDevices(['ghost'])).get('ghost')).toBeNull();
  });
});

describe('resolveDeviceIdsForSoftwarePolicy managed branch (#6960)', () => {
  const managedPrefix = () => [
    [{ managedByLinkId: 'link-1' }],
    [{ configPolicyId: 'cp-owner' }],
    [{ level: 'device', targetId: 'dev-1' }, { level: 'device', targetId: 'dev-2' }],
  ];

  it('keeps only candidates whose security_agents winner is the managed link (batched)', async () => {
    queue(
      ...managedPrefix(),
      devices(2),
      [{ id: 'org-1', partnerId: 'ptr-1', type: 'customer' }],
      [],
      [candidate('link-1', 'organization', 'org-1'), candidate('link-optout', 'device', 'dev-2')],
    );
    await expect(resolveDeviceIdsForSoftwarePolicy('sp-managed')).resolves.toEqual(['dev-1']);
    expect(fromTables[0]).toBe(softwarePolicies);
    expect(fromTables[1]).toBe(configPolicyEffectiveFeatureLinks);
  });

  it('a non-managed policy takes the software_policy path unchanged', async () => {
    queue(
      [{ managedByLinkId: null }],
      [], // no config policy links this software policy
    );
    await expect(resolveDeviceIdsForSoftwarePolicy('sp-customer')).resolves.toEqual([]);
    expect(fromTables).toEqual([softwarePolicies, configPolicyEffectiveFeatureLinks]);
  });
});
