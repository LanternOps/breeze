import { describe, it, expect, vi, beforeEach } from 'vitest';

// `resolveHelperPermissionLevelForDevice` had no test at all before #5080 W02,
// and it is security-relevant: its fallback is the permissive-ish 'standard',
// so a resolver that silently reads nothing OVER-permissions the on-device
// helper agent rather than failing shut. W02 switched its join to the effective
// view, which is exactly the kind of change that can start returning zero rows
// without anything going red.
//
// Deliberately NOT mocking '../db/schema': the join target is asserted by
// object identity against the real view export, so a lookalike stub cannot
// satisfy it and a reader left on the base table cannot either.
vi.mock('../db', () => ({
  db: { select: vi.fn() },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  getCurrentDbAccessContext: vi.fn(() => ({ scope: 'system' as const })),
}));

// Field-provenance tiering — a device_group-level helper-permission
// assignment grants technician/AI-chat capability to the on-device helper
// (execution_gated per configFeatureTypes.ts). A device that self-selects into
// a group via an agent-reported filter field must not be able to elevate its
// own helper permission level. Mocked as a pass-through by default; a
// dedicated test overrides it to prove the gate is wired in.
const mockResolveExecutionSafeGroupIds = vi.fn(async (groupIds: string[]) => ({
  allowedGroupIds: groupIds,
  refusedGroups: [] as Array<{ id: string; refusedFields: string[] }>,
}));
const mockAuditRefusedExecutionGroups = vi.fn();
vi.mock('./executionTargetGating', () => ({
  resolveExecutionSafeGroupIds: (...args: [string[]]) => mockResolveExecutionSafeGroupIds(...args),
  auditRefusedExecutionGroups: (...args: unknown[]) => mockAuditRefusedExecutionGroups(...args),
}));

import {
  resolveHelperPermissionLevelForDevice,
  deriveHelperPermissionLevelFromSettings,
  normalizeHelperPermissionLevel,
} from './helperPermissions';
import { db } from '../db';
import {
  configPolicyEffectiveFeatureLinks,
  configPolicyFeatureLinks,
} from '../db/schema';

const joined: unknown[] = [];

function chain(rows: unknown[]) {
  const c: any = { then: (resolve: (v: unknown) => void) => resolve(rows) };
  for (const m of ['where', 'orderBy', 'limit']) c[m] = () => c;
  for (const m of ['from', 'innerJoin', 'leftJoin']) {
    c[m] = (table: unknown) => {
      joined.push(table);
      return c;
    };
  }
  return c;
}

const DEVICE = { orgId: 'org-1', siteId: 'site-1' };

function queue(...rowSets: unknown[][]) {
  const m = vi.mocked(db.select);
  for (const rows of rowSets) m.mockReturnValueOnce(chain(rows) as any);
}

// device row, org row, group memberships, then the policy join.
function queueResolver(policyRows: unknown[]) {
  queue([DEVICE], [{ partnerId: 'ptr-1' }], [], policyRows);
}

beforeEach(() => {
  joined.length = 0;
  vi.mocked(db.select).mockReset();
});

describe('resolveHelperPermissionLevelForDevice', () => {
  it('joins the effective view, not the authored table', async () => {
    queueResolver([]);
    await resolveHelperPermissionLevelForDevice('dev-1');
    expect(joined).toContain(configPolicyEffectiveFeatureLinks);
    expect(joined).not.toContain(configPolicyFeatureLinks);
  });

  it("applies a parent's inherited restriction to a child's device", async () => {
    // The inherited row carries the PARENT's link and its settings; the level it
    // names must win over the permissive default.
    queueResolver([
      { level: 'organization', assignmentPriority: 0, inlineSettings: { permissionLevel: 'basic' } },
    ]);
    expect(await resolveHelperPermissionLevelForDevice('dev-1')).toBe('basic');
  });

  it('closest assignment wins over a broader one', async () => {
    queueResolver([
      { level: 'organization', assignmentPriority: 0, inlineSettings: { permissionLevel: 'extended' } },
      { level: 'device', assignmentPriority: 0, inlineSettings: { permissionLevel: 'basic' } },
    ]);
    expect(await resolveHelperPermissionLevelForDevice('dev-1')).toBe('basic');
  });

  it('falls back to the caller-supplied level when nothing resolves', async () => {
    queueResolver([]);
    expect(await resolveHelperPermissionLevelForDevice('dev-1', 'basic')).toBe('basic');
  });

  it('falls back for an unknown device rather than throwing', async () => {
    queue([]); // no device row
    expect(await resolveHelperPermissionLevelForDevice('nope', 'basic')).toBe('basic');
  });
});

describe('resolveHelperPermissionLevelForDevice — device_group gated by field provenance', () => {
  beforeEach(() => {
    joined.length = 0;
    vi.mocked(db.select).mockReset();
    mockResolveExecutionSafeGroupIds.mockImplementation(async (groupIds: string[]) => ({
      allowedGroupIds: groupIds,
      refusedGroups: [],
    }));
    mockAuditRefusedExecutionGroups.mockReset();
  });

  it('excludes a refused group\'s extended-permission assignment, falling back to the org-level default', async () => {
    mockResolveExecutionSafeGroupIds.mockResolvedValueOnce({
      allowedGroupIds: [],
      refusedGroups: [{ id: 'grp-1', refusedFields: ['hostname'] }],
    });
    // device, org, group memberships, then the policy join — the device_group
    // row must NOT win even though it is queued as the closer match.
    queue(
      [DEVICE],
      [{ partnerId: 'ptr-1' }],
      [{ groupId: 'grp-1' }],
      [
        { level: 'organization', assignmentPriority: 0, inlineSettings: { permissionLevel: 'basic' } },
      ],
    );

    const level = await resolveHelperPermissionLevelForDevice('dev-1');

    expect(level).toBe('basic');
    expect(mockAuditRefusedExecutionGroups).toHaveBeenCalledWith(
      'org-1',
      'helper_permissions.execution_target_refused_agent_reported_fields',
      [{ id: 'grp-1', refusedFields: ['hostname'] }],
    );
  });
});

describe('helper permission level coercion', () => {
  it('accepts only the three known levels', () => {
    expect(normalizeHelperPermissionLevel('basic')).toBe('basic');
    expect(normalizeHelperPermissionLevel('standard')).toBe('standard');
    expect(normalizeHelperPermissionLevel('extended')).toBe('extended');
    expect(normalizeHelperPermissionLevel('root')).toBeNull();
    expect(normalizeHelperPermissionLevel(undefined)).toBeNull();
  });

  it('falls back rather than trusting a malformed settings blob', () => {
    expect(deriveHelperPermissionLevelFromSettings({ permissionLevel: 'root' }, 'basic')).toBe('basic');
    expect(deriveHelperPermissionLevelFromSettings(null, 'basic')).toBe('basic');
    expect(deriveHelperPermissionLevelFromSettings('nonsense', 'basic')).toBe('basic');
  });
});
