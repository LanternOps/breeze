import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { devices } from '../../db/schema/devices';
import { pickWinner, resolveMonitorsForDevice, selectContributingAttachments, MONITOR_RESOLVER_CAPABILITIES, type MonitorCandidate } from './monitorResolver';

function candidate(overrides: Partial<MonitorCandidate>): MonitorCandidate {
  return {
    monitorId: 'm',
    enabled: true,
    overrides: null,
    sourcePolicyId: 'p',
    sourceLevel: 'organization',
    inheritedFromParent: false,
    priority: 0,
    assignedAt: 0,
    ...overrides,
  };
}

describe('monitor attachment ranking (#5289)', () => {
  it('site override beats org baseline; a policy own row beats the one it inherits from its parent', () => {
    const winner = pickWinner([
      candidate({ sourcePolicyId: 'org-base', sourceLevel: 'organization' }),
      candidate({ sourcePolicyId: 'site-x', sourceLevel: 'site', enabled: false }),
      candidate({
        sourcePolicyId: 'site-x-parent',
        sourceLevel: 'site',
        inheritedFromParent: true,
        overrides: { value: 95 },
      }),
    ]);
    expect(winner.sourcePolicyId).toBe('site-x');
    expect(winner.enabled).toBe(false);
  });

  it('device beats device_group beats site beats organization beats partner', () => {
    const all: MonitorCandidate[] = [
      candidate({ sourcePolicyId: 'partner', sourceLevel: 'partner' }),
      candidate({ sourcePolicyId: 'org', sourceLevel: 'organization' }),
      candidate({ sourcePolicyId: 'site', sourceLevel: 'site' }),
      candidate({ sourcePolicyId: 'group', sourceLevel: 'device_group' }),
      candidate({ sourcePolicyId: 'device', sourceLevel: 'device' }),
    ];
    expect(pickWinner(all).sourcePolicyId).toBe('device');
    expect(pickWinner(all.slice(0, 4)).sourcePolicyId).toBe('group');
    expect(pickWinner(all.slice(0, 3)).sourcePolicyId).toBe('site');
    expect(pickWinner(all.slice(0, 2)).sourcePolicyId).toBe('org');
  });

  it('at the same level the LOWER assignment priority wins, then the earlier assignment', () => {
    expect(
      pickWinner([
        candidate({ sourcePolicyId: 'late', priority: 10 }),
        candidate({ sourcePolicyId: 'early', priority: 1 }),
      ]).sourcePolicyId,
    ).toBe('early');

    expect(
      pickWinner([
        candidate({ sourcePolicyId: 'second', assignedAt: 200 }),
        candidate({ sourcePolicyId: 'first', assignedAt: 100 }),
      ]).sourcePolicyId,
    ).toBe('first');
  });

  it('the winner carries its own overrides, not a merge of the losers', () => {
    const winner = pickWinner([
      candidate({ sourcePolicyId: 'org', overrides: { value: 70, durationMinutes: 5 } }),
      candidate({ sourcePolicyId: 'site', sourceLevel: 'site', overrides: { value: 95 } }),
    ]);
    expect(winner.overrides).toEqual({ value: 95 });
  });
});


describe('monitor assignment device filters (#6344)', () => {
  it.each([
    ['workstation', 'windows'],
    ['server', 'linux'],
    ['laptop', 'macos'],
  ])('gates assignments on role %s and OS %s before loading attachments', async (deviceRole, osType) => {
    const assignmentWhere = vi.fn().mockResolvedValue([]);
    const select = vi.fn()
      .mockReturnValueOnce({ from: () => ({ where: () => ({ limit: async () => [
        { id: 'device', orgId: 'org', siteId: 'site', deviceRole, osType },
      ] }) }) })
      .mockReturnValueOnce({ from: () => ({ where: () => ({ limit: async () => [{ partnerId: 'partner' }] }) }) })
      .mockReturnValueOnce({ from: () => ({ where: async () => [] }) })
      .mockReturnValueOnce({ from: () => ({ innerJoin: () => ({ where: assignmentWhere }) }) });
    const executor = { select } as unknown as NonNullable<Parameters<typeof resolveMonitorsForDevice>[1]>;

    expect(await resolveMonitorsForDevice('device', executor)).toEqual({ kind: 'resolved', monitors: [] });
    const query = new PgDialect().sqlToQuery(assignmentWhere.mock.calls[0]![0]);
    expect(query.sql).toContain('"config_policy_assignments"."role_filter" IS NULL');
    expect(query.sql).toContain('ANY("config_policy_assignments"."role_filter")');
    expect(query.sql).toContain('"config_policy_assignments"."os_filter" IS NULL');
    expect(query.sql).toContain('ANY("config_policy_assignments"."os_filter")');
    expect(query.params.slice(-2)).toEqual([deviceRole, osType]);
    expect(select.mock.calls[0]![0]).toMatchObject({ deviceRole: devices.deviceRole, osType: devices.osType });
    expect(select).toHaveBeenCalledTimes(4);
  });
});

describe('inheritance: replace (W05c1, spec §Inheritance correction)', () => {
  const assignment = (policyId: string, level: 'organization' | 'site' | 'partner', parentPolicyId: string | null = null, priority = 0) => ({
    policyId, parentPolicyId, level, priority, createdAt: new Date('2026-01-01T00:00:00Z'),
  });
  const row = (configPolicyId: string, monitorId: string) => ({ configPolicyId, monitorId, enabled: true, overrides: null });

  it('among replace links only the closest contributes; cumulative links still add; a replace policy never consults its parent', () => {
    const assignments = [
      assignment('partner-p', 'partner'),          // cumulative: built-ins
      assignment('org-p', 'organization', 'org-parent'), // replace: converted org rules
      assignment('site-p', 'site'),                // replace: converted site rules
    ];
    const byPolicy = new Map([
      ['partner-p', [row('partner-p', 'builtin-cpu')]],
      ['org-p', [row('org-p', 'org-rule-1')]],
      ['org-parent', [row('org-parent', 'parent-rule')]],
      ['site-p', [row('site-p', 'site-rule-1')]],
    ]);
    const inheritance = new Map([['org-p', 'replace' as const], ['site-p', 'replace' as const]]);

    const contributed = selectContributingAttachments({ assignments, byPolicy, inheritanceByPolicy: inheritance });
    const ids = contributed.map((c) => `${c.sourcePolicyId}:${c.monitorId}:${c.inheritedFromParent ? 'parent' : 'own'}`).sort();
    expect(ids).toEqual(['partner-p:builtin-cpu:own', 'site-p:site-rule-1:own']);
  });

  it('an empty replace attachment set continues to shadow inherited monitors', () => {
    const assignments = [assignment('child', 'site', 'parent')];
    const byPolicy = new Map([['parent', [row('parent', 'cpu')]]]);
    expect(selectContributingAttachments({ assignments, byPolicy,
      inheritanceByPolicy: new Map([['child', 'replace']]) })).toEqual([]);
  });
  it('cumulative everywhere reproduces today\'s behaviour (own + parent for every assignment)', () => {
    const assignments = [assignment('org-p', 'organization', 'org-parent'), assignment('site-p', 'site')];
    const byPolicy = new Map([
      ['org-p', [row('org-p', 'm1')]],
      ['org-parent', [row('org-parent', 'm2')]],
      ['site-p', [row('site-p', 'm3')]],
    ]);
    const contributed = selectContributingAttachments({ assignments, byPolicy, inheritanceByPolicy: new Map() });
    expect(contributed.map((c) => c.monitorId).sort()).toEqual(['m1', 'm2', 'm3']);
  });

  it('declares the capabilities the converter checks', () => {
    expect(MONITOR_RESOLVER_CAPABILITIES).toEqual({ roleOsFilters: true, inheritance: true });
  });
});
