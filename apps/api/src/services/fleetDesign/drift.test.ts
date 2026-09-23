import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FleetDesignOutcome } from '@breeze/shared';

/**
 * Fake Drizzle executor (pattern: services/fleetDesign/ledger.test.ts). A
 * FIFO queue of result rows is consumed on every `.from()` call in call
 * order; `.where`/`.orderBy`/`.limit`/`.innerJoin` are chainable and the
 * captured entry records the shape.
 */
interface SelectEntry { table: unknown; seq: number; where?: unknown; limit?: number; orderBy?: unknown[] }

function thenable(rows: Array<Record<string, unknown>>, entry: SelectEntry) {
  const p = Promise.resolve(rows) as Promise<Array<Record<string, unknown>>> & Record<string, unknown>;
  p.limit = (n: number) => { entry.limit = n; return thenable(rows.slice(0, n), entry); };
  p.orderBy = (...cols: unknown[]) => { entry.orderBy = cols; return thenable(rows, entry); };
  return p;
}

function makeExec(rowQueue: Array<Array<Record<string, unknown>>>) {
  const q = [...rowQueue];
  const selects: SelectEntry[] = [];
  let seq = 0;
  const exec = {
    select: () => ({
      from: (table: unknown) => {
        const rows = q.shift() ?? [];
        const entry: SelectEntry = { table, seq: (seq += 1) };
        selects.push(entry);
        const chain = {
          where: (cond: unknown) => { entry.where = cond; return thenable(rows, entry); },
          innerJoin: () => chain,
        };
        return chain;
      },
    }),
  };
  return { exec, selects };
}

const holder: { exec: ReturnType<typeof makeExec>['exec'] | null } = { exec: null };
vi.mock('../../db', () => ({
  db: {
    select: (...args: unknown[]) => (holder.exec as unknown as { select: (...a: unknown[]) => unknown }).select(...args),
  },
}));

import {
  buildApprovedDesign,
  computeDrift,
  loadApprovedDesign,
  type ApprovedDesignSummary,
  type DriftLiveState,
} from './drift';

const ORG = '11111111-1111-4111-8111-111111111111';
const RUN = '22222222-2222-4222-8222-222222222222';
const GROUP = '44444444-4444-4444-8444-444444444444';
const POLICY = '55555555-5555-4555-8555-555555555555';
const OTHER_POLICY = '66666666-6666-4666-8666-666666666666';
const RETIRED_POLICY = '77777777-7777-4777-8777-777777777777';
const DEV_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DEV_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const APPLIED_AT = '2026-09-01T10:00:00.000Z';

function outcome(): FleetDesignOutcome {
  return {
    schemaVersion: 1,
    generatedAt: '2026-08-31T00:00:00.000Z',
    markdown: '',
    thresholds: { confidence: 0.6, precursors: { diskUsedPercent: 80, rebootPendingDays: 7, patchAgeDays: 30, certificateDays: 30, serviceRestartsPer30d: 2 } },
    sections: {
      found: { summary: [], findings: [] },
      functions: [
        { functionKey: 'file_server', label: 'File servers', deviceIds: [DEV_A, DEV_B], confidence: 0.9, evidence: [] },
      ],
      monitoring: [
        {
          functionKey: 'file_server',
          watches: [
            { watchType: 'service', name: 'LanmanServer', alertOnStop: true, autoRestart: true, rationale: 'r' },
            { watchType: 'service', name: 'Spooler', alertOnStop: true, autoRestart: false, rationale: 'r' },
          ],
          alertRules: [
            { name: 'Disk over 90%', severity: 'high', kind: 'disk', condition: { operator: 'gt', value: 90 }, responses: [], deliveryMode: 'inherit', deliveryChannelIds: [], cooldownMinutes: 30, rationale: 'r', action: 'none', paging: 'none' },
            { name: 'SMB share offline', severity: 'critical', kind: 'disk', condition: { operator: 'gt', value: 90 }, responses: [], deliveryMode: 'inherit', deliveryChannelIds: [], cooldownMinutes: 10, rationale: 'r', action: 'none', paging: 'always' },
          ],
        },
      ],
      retired: [
        { kind: 'rule', policyId: RETIRED_POLICY, policyName: 'Old baseline', itemName: 'Ping every minute', reason: 'noise' },
        { kind: 'watch', policyId: RETIRED_POLICY, policyName: 'Old baseline', itemName: 'Fax', reason: 'gone' },
      ],
      automation: [],
      legacy: [],
      baseline: { notes: [], numbers: { alertsPer100EndpointsPerMonth: null, ticketsPerMonth: null, precursors: [] } },
      unsure: { lowConfidenceFunctions: [], unreachableDevices: [], needsHuman: [], roleCorrections: [] },
    },
  };
}

type LedgerRowLike = Parameters<typeof buildApprovedDesign>[0][number];

function ledgerRows(overrides: Partial<Record<string, Partial<LedgerRowLike>>> = {}): LedgerRowLike[] {
  const base = (itemRef: string, itemKind: LedgerRowLike['itemKind'], step: number, createdRefs: Record<string, unknown> = {}): LedgerRowLike => ({
    itemRef, itemKind, step, status: 'applied', createdRefs, appliedAt: new Date(APPLIED_AT), ...(overrides[itemRef] ?? {}),
  });
  return [
    base('functions:file_server', 'function', 1, { groupId: GROUP, groupCreated: true, membershipSnapshot: [DEV_A, DEV_B] }),
    base('retired:0', 'retired', 2, { policyId: RETIRED_POLICY, linkId: 'l1' }),
    base('retired:1', 'retired', 2, { policyId: RETIRED_POLICY, linkId: 'l1' }),
    base('policy:file_server', 'policy', 3, { policyId: POLICY, groupId: GROUP, assignmentId: 'as1' }),
    base('monitoring:file_server:watch:0', 'watch', 3, { policyId: POLICY }),
    base('monitoring:file_server:watch:1', 'watch', 3, { policyId: POLICY }),
    base('monitoring:file_server:rule:0', 'rule', 3, { policyId: POLICY }),
    base('monitoring:file_server:rule:1', 'rule', 3, { policyId: POLICY }),
  ];
}

function approved(): ApprovedDesignSummary {
  return buildApprovedDesign(ledgerRows(), outcome(), RUN)!;
}

function live(): DriftLiveState {
  return {
    policies: [
      {
        id: POLICY, name: 'Fleet Design — File servers', status: 'active', ownerScope: 'organization', createdAt: APPLIED_AT,
        watches: [
          { watchType: 'service', name: 'LanmanServer', enabled: true },
          { watchType: 'service', name: 'Spooler', enabled: true },
        ],
        rules: [
          { name: 'Disk over 90%', severity: 'high', cooldownMinutes: 30 },
          { name: 'SMB share offline', severity: 'critical', cooldownMinutes: 10 },
        ],
      },
      {
        id: RETIRED_POLICY, name: 'Old baseline', status: 'active', ownerScope: 'organization', createdAt: '2025-01-01T00:00:00.000Z',
        watches: [{ watchType: 'service', name: 'Fax', enabled: false }],
        rules: [{ name: 'Kept rule', severity: 'low', cooldownMinutes: 5 }],
      },
    ],
    assignments: [{ policyId: POLICY, level: 'device_group', targetId: GROUP, priority: 50, roleFilter: null }],
    groupMembers: { [GROUP]: [DEV_A, DEV_B] },
  };
}

describe('buildApprovedDesign', () => {
  it('assembles functions, policies, watches, rules and retired items from applied ledger rows', () => {
    const a = approved();
    expect(a.reportRunId).toBe(RUN);
    expect(a.appliedAt).toBe(APPLIED_AT);
    expect(a.functions).toHaveLength(1);
    const fn = a.functions[0]!;
    expect(fn).toMatchObject({ functionKey: 'file_server', label: 'File servers', groupId: GROUP, policyId: POLICY, deviceIds: [DEV_A, DEV_B] });
    expect(fn.watches).toEqual([
      { watchType: 'service', name: 'LanmanServer', enabled: true },
      { watchType: 'service', name: 'Spooler', enabled: true },
    ]);
    expect(fn.rules).toEqual([
      { name: 'Disk over 90%', severity: 'high', cooldownMinutes: 30 },
      { name: 'SMB share offline', severity: 'critical', cooldownMinutes: 10 },
    ]);
    expect(a.retired).toEqual([
      { kind: 'rule', policyId: RETIRED_POLICY, policyName: 'Old baseline', itemName: 'Ping every minute' },
      { kind: 'watch', policyId: RETIRED_POLICY, policyName: 'Old baseline', itemName: 'Fax' },
    ]);
  });

  it('ignores rolled-back and failed rows — a rolled-back watch is not part of the approved design', () => {
    const rows = ledgerRows({
      'monitoring:file_server:watch:1': { status: 'rolled_back' },
      'retired:1': { status: 'failed' },
    });
    const a = buildApprovedDesign(rows, outcome(), RUN)!;
    expect(a.functions[0]!.watches.map((w) => w.name)).toEqual(['LanmanServer']);
    expect(a.retired).toHaveLength(1);
  });

  it('returns null when no applied policy row exists', () => {
    const rows = ledgerRows({ 'policy:file_server': { status: 'rolled_back' } });
    expect(buildApprovedDesign(rows, outcome(), RUN)).toBeNull();
  });

  it('parses custom function keys that themselves contain a colon', () => {
    const o = outcome();
    o.sections.functions[0]!.functionKey = 'custom:pos-terminal';
    o.sections.monitoring[0]!.functionKey = 'custom:pos-terminal';
    const rows = ledgerRows().map((r) => ({ ...r, itemRef: r.itemRef.replace('file_server', 'custom:pos-terminal') }));
    const a = buildApprovedDesign(rows, o, RUN)!;
    expect(a.functions[0]!.functionKey).toBe('custom:pos-terminal');
    expect(a.functions[0]!.watches).toHaveLength(2);
    expect(a.functions[0]!.rules).toHaveLength(2);
  });
});

describe('computeDrift', () => {
  it('reports nothing when the live fleet matches the approved design', () => {
    const d = computeDrift(approved(), live());
    expect(d).toEqual({ approvedReportRunId: RUN, appliedAt: APPLIED_AT, missing: [], extra: [], changed: [] });
  });

  it('a watch disabled by hand → changed (enabled true → false)', () => {
    const l = live();
    l.policies[0]!.watches[1]!.enabled = false;
    const d = computeDrift(approved(), l);
    expect(d.changed).toEqual([
      { functionKey: 'file_server', kind: 'watch', name: 'Spooler', field: 'enabled', approved: 'true', live: 'false' },
    ]);
    expect(d.missing).toEqual([]);
    expect(d.extra).toEqual([]);
  });

  it('a rule whose severity or cooldown was edited → changed, one row per field', () => {
    const l = live();
    l.policies[0]!.rules[0] = { name: 'Disk over 90%', severity: 'medium', cooldownMinutes: 60 };
    const d = computeDrift(approved(), l);
    expect(d.changed).toEqual([
      { functionKey: 'file_server', kind: 'rule', name: 'Disk over 90%', field: 'severity', approved: 'high', live: 'medium' },
      { functionKey: 'file_server', kind: 'rule', name: 'Disk over 90%', field: 'cooldownMinutes', approved: '30', live: '60' },
    ]);
  });

  it('a rule deleted → missing', () => {
    const l = live();
    l.policies[0]!.rules = l.policies[0]!.rules.filter((r) => r.name !== 'SMB share offline');
    const d = computeDrift(approved(), l);
    expect(d.missing).toEqual([{ functionKey: 'file_server', kind: 'rule', name: 'SMB share offline' }]);
  });

  it('the whole policy deleted → every watch and rule missing plus the assignment', () => {
    const l = live();
    l.policies = l.policies.filter((p) => p.id !== POLICY);
    l.assignments = [];
    const d = computeDrift(approved(), l);
    // The policy row is gone, so the assignment is named by the function label.
    expect(d.missing.map((m) => `${m.kind}:${m.name}`).sort()).toEqual([
      'assignment:File servers',
      'rule:Disk over 90%',
      'rule:SMB share offline',
      'watch:LanmanServer',
      'watch:Spooler',
    ].sort());
  });

  it('the policy unassigned from the function group → missing assignment', () => {
    const l = live();
    l.assignments = [];
    const d = computeDrift(approved(), l);
    expect(d.missing).toEqual([{ functionKey: 'file_server', kind: 'assignment', name: 'Fleet Design — File servers' }]);
  });

  it('a device removed from the function group → missing group_member', () => {
    const l = live();
    l.groupMembers[GROUP] = [DEV_A];
    const d = computeDrift(approved(), l);
    expect(d.missing).toEqual([{ functionKey: 'file_server', kind: 'group_member', name: DEV_B }]);
  });

  it('a rule hand-added to a Fleet Design policy → extra, counted over the group', () => {
    const l = live();
    l.policies[0]!.rules.push({ name: 'Hand-added', severity: 'low', cooldownMinutes: 5 });
    const d = computeDrift(approved(), l);
    expect(d.extra).toEqual([
      { policyId: POLICY, policyName: 'Fleet Design — File servers', kind: 'rule', name: 'Hand-added', deviceCount: 2 },
    ]);
  });

  it('a retired item that is live again → extra (rule re-added, watch re-enabled)', () => {
    const l = live();
    l.policies[1]!.rules.push({ name: 'Ping every minute', severity: 'info', cooldownMinutes: 1 });
    l.policies[1]!.watches[0]!.enabled = true;
    const d = computeDrift(approved(), l);
    expect(d.extra).toEqual([
      { policyId: RETIRED_POLICY, policyName: 'Old baseline', kind: 'rule', name: 'Ping every minute', deviceCount: 0 },
      { policyId: RETIRED_POLICY, policyName: 'Old baseline', kind: 'watch', name: 'Fax', deviceCount: 0 },
    ]);
  });

  it('a rule on an org policy created after the design was applied → extra; older untouched policies are not drift', () => {
    const l = live();
    l.policies.push({
      id: OTHER_POLICY, name: 'New by hand', status: 'active', ownerScope: 'organization', createdAt: '2026-09-05T00:00:00.000Z',
      watches: [], rules: [{ name: 'CPU hot', severity: 'medium', cooldownMinutes: 15 }],
    });
    l.assignments.push({ policyId: OTHER_POLICY, level: 'device_group', targetId: GROUP, priority: 10, roleFilter: null });
    const d = computeDrift(approved(), l);
    expect(d.extra).toEqual([
      { policyId: OTHER_POLICY, policyName: 'New by hand', kind: 'rule', name: 'CPU hot', deviceCount: 2 },
    ]);
    // "Kept rule" on the pre-existing Old baseline policy is NOT reported.
    expect(d.extra.some((x) => x.name === 'Kept rule')).toBe(false);
  });

  it('partner-wide policies are never drift (the org design does not own them)', () => {
    const l = live();
    l.policies.push({
      id: OTHER_POLICY, name: 'Partner baseline', status: 'active', ownerScope: 'partner', createdAt: '2026-09-05T00:00:00.000Z',
      watches: [], rules: [{ name: 'Partner rule', severity: 'medium', cooldownMinutes: 15 }],
    });
    expect(computeDrift(approved(), l).extra).toEqual([]);
  });
});

describe('loadApprovedDesign', () => {
  beforeEach(() => { holder.exec = null; });

  it('returns null when the org has no applied, non-rolled-back policy row', async () => {
    const { exec, selects } = makeExec([[]]);
    holder.exec = exec;
    expect(await loadApprovedDesign(ORG)).toBeNull();
    expect(selects).toHaveLength(1);
    expect(selects[0]!.limit).toBe(1);
    expect(selects[0]!.orderBy).toBeDefined();
  });

  it('picks the newest applied run and assembles it from its ledger and stored outcome', async () => {
    const { exec } = makeExec([
      [{ reportRunId: RUN }],
      ledgerRows() as unknown as Array<Record<string, unknown>>,
      [{ summary: { fleetDesign: { outcome: outcome() } } }],
    ]);
    holder.exec = exec;
    const a = await loadApprovedDesign(ORG);
    expect(a?.reportRunId).toBe(RUN);
    expect(a?.functions[0]?.policyId).toBe(POLICY);
  });
});
