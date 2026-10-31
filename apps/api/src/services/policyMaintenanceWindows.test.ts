/**
 * #10409 — `manage_maintenance_windows list` read only the legacy standalone
 * `maintenance_windows` table, so a fleet whose windows all come from
 * configuration policies (the only place new windows can be authored) listed
 * nothing. This suite pins the policy-window reader that the tool now merges
 * in: shape, next-occurrence projection, and the site axis.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const selectResults: unknown[][] = [];
const selectCalls: Array<Record<string, unknown[]>> = [];

function chain(result: unknown[]) {
  const calls: Record<string, unknown[]> = {};
  selectCalls.push(calls);
  const node: Record<string, unknown> = {};
  for (const method of ['from', 'innerJoin', 'leftJoin', 'where', 'orderBy', 'limit']) {
    node[method] = (...args: unknown[]) => {
      calls[method] = args;
      return node;
    };
  }
  node.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return node;
}

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => chain(selectResults.shift() ?? [])),
  },
}));

const policyAccessCondition = vi.fn((_auth: unknown) => ({ marker: 'policy-access' }) as unknown);
vi.mock('./configurationPolicy', () => ({
  policyAccessCondition: (auth: unknown) => policyAccessCondition(auth),
}));

import { listPolicyMaintenanceWindows } from './policyMaintenanceWindows';

// Wednesday 2026-10-28 03:00 UTC.
const NOW = new Date('2026-10-28T03:00:00.000Z');

function settings(overrides: Record<string, unknown> = {}) {
  return {
    id: 'mset-1',
    featureLinkId: 'link-1',
    recurrence: 'weekly',
    durationHours: 4,
    timezone: 'UTC',
    windowStart: '02:00',
    suppressAlerts: true,
    suppressPatching: true,
    suppressAutomations: false,
    suppressScripts: false,
    rebootIfPending: true,
    notifyBeforeMinutes: 15,
    notifyOnStart: true,
    notifyOnEnd: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function policyRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    configPolicyId: id,
    policyName: `Policy ${id}`,
    orgId: null,
    orgName: null,
    sourcePolicyId: id,
    inherited: false,
    settings: settings({ id: `mset-${id}` }),
    ...overrides,
  };
}

function assignment(configPolicyId: string, level: string, targetId: string, extra: Record<string, unknown> = {}) {
  return { configPolicyId, level, targetId, roleFilter: null, osFilter: null, ...extra };
}

/** Walks a drizzle SQL tree (it is cyclic through column → table) for the mocked access marker. */
function containsMarker(node: unknown, marker: string, seen = new Set<unknown>()): boolean {
  if (!node || typeof node !== 'object' || seen.has(node)) return false;
  seen.add(node);
  if ((node as { marker?: unknown }).marker === marker) return true;
  const children = Array.isArray(node) ? node : (node as { queryChunks?: unknown[] }).queryChunks;
  return Array.isArray(children) && children.some((child) => containsMarker(child, marker, seen));
}

const partnerAuth ={ scope: 'partner', partnerId: 'partner-1', allowedSiteIds: undefined } as never;
const siteAuth = (sites: string[]) => ({ scope: 'organization', orgId: 'org-1', allowedSiteIds: sites }) as never;

describe('listPolicyMaintenanceWindows (#10409)', () => {
  beforeEach(() => {
    selectResults.length = 0;
    selectCalls.length = 0;
    policyAccessCondition.mockClear();
  });

  it('lists a partner-wide policy window with its schedule, projection and assignment levels', async () => {
    selectResults.push(
      [policyRow('pol-default', { policyName: 'Default Workstation Policy' })],
      [assignment('pol-default', 'partner', 'partner-1', { roleFilter: ['workstation'] })],
    );

    const { windows, truncated } = await listPolicyMaintenanceWindows(partnerAuth, { limit: 25, now: NOW });

    expect(truncated).toBe(false);
    expect(windows).toEqual([
      {
        source: 'config_policy',
        configPolicyId: 'pol-default',
        policyName: 'Default Workstation Policy',
        policyScope: 'partner_wide',
        orgId: null,
        orgName: null,
        inheritedFromPolicyId: null,
        recurrence: 'weekly',
        windowStart: '02:00',
        durationHours: 4,
        timezone: 'UTC',
        suppressAlerts: true,
        suppressPatching: true,
        suppressAutomations: false,
        suppressScripts: false,
        rebootIfPending: true,
        activeNow: false,
        // Weekly windows open on Sunday at windowStart in the window's zone.
        nextWindow: { startsAt: '2026-11-01T02:00:00.000Z', endsAt: '2026-11-01T06:00:00.000Z' },
        assignmentCount: 1,
        assignments: [{ level: 'partner', roleFilter: ['workstation'], osFilter: null }],
      },
    ]);
  });

  it('reads through the caller’s policy access condition and only active policies', async () => {
    selectResults.push([], []);
    await listPolicyMaintenanceWindows(partnerAuth, { limit: 25, now: NOW });

    expect(policyAccessCondition).toHaveBeenCalledWith(partnerAuth);
    expect(containsMarker(selectCalls[0]?.where, 'policy-access')).toBe(true);
  });

  it('filters to ACTIVE policies (resolution ignores inactive/archived ones)', async () => {
    policyAccessCondition.mockReturnValueOnce(undefined); // system scope: no access predicate
    selectResults.push([], []);
    await listPolicyMaintenanceWindows(partnerAuth, { limit: 25, now: NOW });

    const where = selectCalls[0]?.where?.[0] as SQL;
    const query = new PgDialect().sqlToQuery(where);
    expect(query.sql).toContain('"status" = $1');
    expect(query.params).toEqual(['active']);
  });

  it('reads one row past the limit for an unrestricted caller and is not truncated at exactly the limit', async () => {
    selectResults.push([policyRow('a'), policyRow('b')], []);

    const { windows, truncated } = await listPolicyMaintenanceWindows(partnerAuth, { limit: 2, now: NOW });

    expect(selectCalls[0]?.limit).toEqual([3]);
    expect(windows).toHaveLength(2);
    expect(truncated).toBe(false);
  });

  it('scans wider (bounded) when filtering happens after the read', async () => {
    selectResults.push([], []);
    await listPolicyMaintenanceWindows(siteAuth(['site-A']), { limit: 2, now: NOW });
    expect(selectCalls[0]?.limit).toEqual([500]);

    selectCalls.length = 0;
    selectResults.push([], []);
    await listPolicyMaintenanceWindows(partnerAuth, { limit: 2, now: NOW, activeOnly: true });
    expect(selectCalls[0]?.limit).toEqual([500]);
  });

  it('reports a window that is open right now as activeNow with the current occurrence', async () => {
    selectResults.push(
      [policyRow('pol-daily', { settings: settings({ id: 'mset-daily', recurrence: 'daily', windowStart: '02:00', durationHours: 2 }) })],
      [assignment('pol-daily', 'organization', 'org-1')],
    );

    const { windows } = await listPolicyMaintenanceWindows(partnerAuth, { limit: 25, now: NOW });

    expect(windows[0]?.activeNow).toBe(true);
    expect(windows[0]?.nextWindow).toEqual({ startsAt: '2026-10-28T02:00:00.000Z', endsAt: '2026-10-28T04:00:00.000Z' });
  });

  it('marks an inherited window with the policy that authored it', async () => {
    selectResults.push(
      [policyRow('pol-child', { orgId: 'org-1', orgName: 'Acme', sourcePolicyId: 'pol-parent', inherited: true })],
      [],
    );

    const { windows } = await listPolicyMaintenanceWindows(partnerAuth, { limit: 25, now: NOW });

    expect(windows[0]).toMatchObject({
      policyScope: 'organization',
      orgId: 'org-1',
      orgName: 'Acme',
      inheritedFromPolicyId: 'pol-parent',
      assignmentCount: 0,
      assignments: [],
    });
  });

  it('never returns assignment target ids', async () => {
    selectResults.push(
      [policyRow('pol-1', { orgId: 'org-1' })],
      [assignment('pol-1', 'site', 'site-SECRET'), assignment('pol-1', 'device', 'device-SECRET')],
    );

    const { windows } = await listPolicyMaintenanceWindows(partnerAuth, { limit: 25, now: NOW });

    const raw = JSON.stringify(windows);
    expect(raw).not.toContain('site-SECRET');
    expect(raw).not.toContain('device-SECRET');
    expect(windows[0]?.assignmentCount).toBe(2);
  });

  it('applies the limit and reports truncation', async () => {
    selectResults.push(
      [policyRow('a'), policyRow('b'), policyRow('c')],
      [],
    );

    const { windows, truncated } = await listPolicyMaintenanceWindows(partnerAuth, { limit: 2, now: NOW });

    expect(windows.map((w) => w.configPolicyId)).toEqual(['a', 'b']);
    expect(truncated).toBe(true);
  });

  it('activeOnly keeps only windows open right now', async () => {
    selectResults.push(
      [
        policyRow('weekly'),
        policyRow('daily', { settings: settings({ id: 'mset-d', recurrence: 'daily', windowStart: '02:00', durationHours: 2 }) }),
      ],
      [],
    );

    const { windows } = await listPolicyMaintenanceWindows(partnerAuth, { limit: 25, now: NOW, activeOnly: true });

    expect(windows.map((w) => w.configPolicyId)).toEqual(['daily']);
  });

  describe('site axis (site-restricted caller)', () => {
    it('hides a policy whose assignments reach only a forbidden site, and its assignments', async () => {
      selectResults.push(
        [policyRow('pol-A', { orgId: 'org-1' }), policyRow('pol-F', { orgId: 'org-1' }), policyRow('pol-org', { orgId: 'org-1' })],
        [
          assignment('pol-A', 'site', 'site-A'),
          assignment('pol-A', 'site', 'site-FORBIDDEN'),
          assignment('pol-F', 'site', 'site-FORBIDDEN'),
          assignment('pol-org', 'organization', 'org-1'),
        ],
      );

      const { windows } = await listPolicyMaintenanceWindows(siteAuth(['site-A']), { limit: 25, now: NOW });

      expect(windows.map((w) => w.configPolicyId)).toEqual(['pol-A', 'pol-org']);
      // Only the assignment that reaches the caller is counted/shown.
      expect(windows[0]?.assignmentCount).toBe(1);
      expect(windows[0]?.assignments).toEqual([{ level: 'site', roleFilter: null, osFilter: null }]);
      expect(windows[1]?.assignments).toEqual([{ level: 'organization', roleFilter: null, osFilter: null }]);
    });

    it('resolves group and device assignments to their sites (siteless targets do not count)', async () => {
      selectResults.push(
        [
          policyRow('pol-grpA', { orgId: 'org-1' }),
          policyRow('pol-grpF', { orgId: 'org-1' }),
          policyRow('pol-devNull', { orgId: 'org-1' }),
          policyRow('pol-devA', { orgId: 'org-1' }),
        ],
        [
          assignment('pol-grpA', 'device_group', 'group-A'),
          assignment('pol-grpA', 'device_group', 'group-FORBIDDEN'),
          assignment('pol-grpF', 'device_group', 'group-FORBIDDEN'),
          assignment('pol-devNull', 'device', 'device-siteless'),
          assignment('pol-devA', 'device', 'device-A'),
        ],
        // filterWindowsToSiteScope: group → site, then device → site.
        [{ id: 'group-A', siteId: 'site-A' }, { id: 'group-FORBIDDEN', siteId: 'site-FORBIDDEN' }],
        [{ id: 'device-siteless', siteId: null }, { id: 'device-A', siteId: 'site-A' }],
      );

      const { windows } = await listPolicyMaintenanceWindows(siteAuth(['site-A']), { limit: 25, now: NOW });

      expect(windows.map((w) => w.configPolicyId)).toEqual(['pol-grpA', 'pol-devA']);
      expect(windows[0]?.assignments).toEqual([{ level: 'device_group', roleFilter: null, osFilter: null }]);
      expect(windows[0]?.assignmentCount).toBe(1);
    });

    it('a caller restricted to no sites still sees partner/org-level windows (they reach every site) and nothing else', async () => {
      selectResults.push(
        [policyRow('pol-partner'), policyRow('pol-site', { orgId: 'org-1' })],
        [assignment('pol-partner', 'partner', 'partner-1'), assignment('pol-site', 'site', 'site-A')],
      );

      const { windows } = await listPolicyMaintenanceWindows(siteAuth([]), { limit: 25, now: NOW });

      expect(windows.map((w) => w.configPolicyId)).toEqual(['pol-partner']);
    });

    it('hides an unassigned policy from a site-restricted caller', async () => {
      selectResults.push([policyRow('pol-none', { orgId: 'org-1' })], []);

      const { windows } = await listPolicyMaintenanceWindows(siteAuth(['site-A']), { limit: 25, now: NOW });

      expect(windows).toEqual([]);
    });
  });
});
