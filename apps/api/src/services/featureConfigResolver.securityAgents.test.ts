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
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    queue(...HIERARCHY, [winnerRow('link-1', { version: 1, agents: [{ vendor: 'huntress', enabled: true, apiKey: 'x' }] })]);
    const r = await resolveSecurityAgentsLinkForDevice('dev-1');
    expect(r?.inlineSettings).toEqual({ version: 1, agents: [] });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('resolveDeviceIdsForSoftwarePolicy managed branch (#6960)', () => {
  it('keeps a candidate whose security_agents winner is the managed link', async () => {
    queue(
      [{ managedByLinkId: 'link-1' }],
      [{ configPolicyId: 'cp-owner' }],
      [{ level: 'device', targetId: 'dev-1' }],
      ...HIERARCHY,
      [winnerRow('link-1')],
    );
    await expect(resolveDeviceIdsForSoftwarePolicy('sp-managed')).resolves.toEqual(['dev-1']);
    expect(fromTables[0]).toBe(softwarePolicies);
    expect(fromTables[1]).toBe(configPolicyEffectiveFeatureLinks);
  });

  it('drops a candidate where a closer security_agents link wins (e.g. an agents: [] opt-out)', async () => {
    queue(
      [{ managedByLinkId: 'link-1' }],
      [{ configPolicyId: 'cp-owner' }],
      [{ level: 'device', targetId: 'dev-1' }],
      ...HIERARCHY,
      [winnerRow('link-closer', { version: 1, agents: [] })],
    );
    await expect(resolveDeviceIdsForSoftwarePolicy('sp-managed')).resolves.toEqual([]);
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
