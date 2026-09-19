import { describe, it, expect } from 'vitest';
import { approvalBatchGroupKey } from '@breeze/shared';

import {
  buildOrgOptions,
  buildSections,
  clusterByOrg,
  GROUP_HOSTNAME_MAX_SHOWN,
  groupHostnameSummary,
  groupIdentity,
  groupTestKey,
  isExpired,
  isGroupable,
  matchesSearch,
  sortRows,
  type PendingApproval,
} from './approvalGrouping';

const NO_DRIFT: ReadonlySet<string> = new Set<string>();

let seq = 0;
function makeApproval(overrides: Partial<PendingApproval> = {}): PendingApproval {
  seq += 1;
  return {
    id: `appr-${seq}`,
    requestingClientLabel: 'Patch Hygiene Agent',
    requestingMachineLabel: null,
    actionLabel: `Restart spooler on dev-${seq}`,
    actionToolName: 'manage_services',
    actionArguments: { deviceId: `dev-${seq}`, action: 'restart' },
    riskTier: 'medium',
    riskSummary: 'Restarts a Windows service.',
    customerTenant: null,
    status: 'pending',
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    decidedAt: null,
    decisionReason: null,
    executionId: null,
    intentId: `intent-${seq}`,
    approvalScope: 'supervised',
    isRecursive: false,
    createdAt: new Date().toISOString(),
    origin: 'ai_agent',
    agentName: 'Patch Hygiene Agent',
    orgId: 'org-1',
    orgName: 'Acme Corp',
    action: 'restart',
    targetDevice: { id: `dev-${seq}`, hostname: `host-${seq}` },
    ...overrides,
  };
}

describe('isGroupable', () => {
  it('accepts a supervised, agent-originated, non-critical card with an org', () => {
    expect(isGroupable(makeApproval())).toBe(true);
  });

  it.each([
    ['a human-originated card', { origin: 'human' as const }],
    ['a four-eyes card', { approvalScope: 'four_eyes' }],
    ['a card with no linked intent org', { orgId: null }],
    // The batch route deliberately does not plumb `reauthVerified`, so a
    // critical card can never clear the L4 ladder inside a batch.
    ['a critical card', { riskTier: 'critical' as const }],
  ])('refuses %s', (_name, overrides) => {
    expect(isGroupable(makeApproval(overrides as Partial<PendingApproval>))).toBe(false);
  });
});

describe('groupIdentity', () => {
  /**
   * The inbox and the server (`batchGroupKey` in
   * `services/approvals/batchDecide.ts`) must derive the SAME key or the UI
   * offers batches the server refuses (#4457). Both now call the shared helper,
   * and this pins that the inbox side really does — a re-inlined local copy
   * here would be exactly the drift the issue was about.
   */
  it('is the shared batch-grouping key, applied to the DTO itself', () => {
    for (const approval of [
      makeApproval(),
      makeApproval({ action: '  ReStart ' }),
      makeApproval({ action: null }),
      makeApproval({ orgId: null }),
      makeApproval({ actionToolName: 'manage_patches', action: 'install' }),
    ]) {
      expect(groupIdentity(approval)).toBe(approvalBatchGroupKey(approval));
    }
  });

  it('separates a differing action into a different identity', () => {
    expect(groupIdentity(makeApproval({ action: 'stop' }))).not.toBe(
      groupIdentity(makeApproval({ action: 'restart' })),
    );
  });
});

describe('groupTestKey', () => {
  it('renders the same triple DOM-safely', () => {
    expect(groupTestKey(makeApproval({ orgId: 'org-1', action: 'restart' }))).toBe(
      'org-1--manage_services--restart',
    );
  });

  it('strips anything a DOM attribute selector could not carry', () => {
    expect(groupTestKey(makeApproval({ orgId: 'org 1/x', action: 'Re Start' }))).toBe(
      'org-1-x--manage_services--re-start',
    );
  });
});

describe('buildSections', () => {
  it('pulls two cards sharing the (org, tool, action) triple under one group', () => {
    const rows = [makeApproval(), makeApproval()];
    const sections = buildSections(rows, NO_DRIFT);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.kind).toBe('group');
    if (sections[0]!.kind !== 'group') return;
    expect(sections[0]!.group.members.map((m) => m.id)).toEqual(rows.map((r) => r.id));
    expect(sections[0]!.group.tool).toBe('manage_services:restart');
  });

  it('still groups two cards whose actions differ only in case and whitespace', () => {
    // The behavioural proof that the shared normalization is what runs here.
    const sections = buildSections(
      [makeApproval({ action: 'restart' }), makeApproval({ action: '  RESTART ' })],
      NO_DRIFT,
    );
    expect(sections).toHaveLength(1);
    expect(sections[0]!.kind).toBe('group');
  });

  it('leaves cards with different actions as standalone rows', () => {
    const sections = buildSections(
      [makeApproval({ action: 'restart' }), makeApproval({ action: 'stop' })],
      NO_DRIFT,
    );
    expect(sections.map((s) => s.kind)).toEqual(['row', 'row']);
  });

  it('leaves cards from different orgs as standalone rows', () => {
    const sections = buildSections(
      [makeApproval({ orgId: 'org-1' }), makeApproval({ orgId: 'org-2' })],
      NO_DRIFT,
    );
    expect(sections.map((s) => s.kind)).toEqual(['row', 'row']);
  });

  it('never makes a group of one', () => {
    const sections = buildSections([makeApproval()], NO_DRIFT);
    expect(sections.map((s) => s.kind)).toEqual(['row']);
  });

  it('drops a drifted card out of its group and leaves the rest batchable', () => {
    const rows = [makeApproval(), makeApproval(), makeApproval()];
    const sections = buildSections(rows, new Set([rows[1]!.id]));
    expect(sections.map((s) => s.kind)).toEqual(['group', 'row']);
    if (sections[0]!.kind !== 'group') return;
    expect(sections[0]!.group.members.map((m) => m.id)).toEqual([rows[0]!.id, rows[2]!.id]);
  });

  it('keeps an ungroupable card as a row even among groupable siblings', () => {
    const rows = [makeApproval(), makeApproval(), makeApproval({ origin: 'human' })];
    const sections = buildSections(rows, NO_DRIFT);
    expect(sections.map((s) => s.kind)).toEqual(['group', 'row']);
  });
});

describe('clusterByOrg', () => {
  it('gathers each org together in first-appearance order without reordering within', () => {
    const a1 = makeApproval({ orgId: 'org-a' });
    const b1 = makeApproval({ orgId: 'org-b' });
    const a2 = makeApproval({ orgId: 'org-a' });
    expect(clusterByOrg([a1, b1, a2]).map((r) => r.id)).toEqual([a1.id, a2.id, b1.id]);
  });

  it('treats every null-org row as one bucket rather than splintering per row', () => {
    const n1 = makeApproval({ orgId: null });
    const a1 = makeApproval({ orgId: 'org-a' });
    const n2 = makeApproval({ orgId: null });
    expect(clusterByOrg([n1, a1, n2]).map((r) => r.id)).toEqual([n1.id, n2.id, a1.id]);
  });
});

describe('sortRows', () => {
  it('orders by soonest expiry, keeping ties in their original order', () => {
    const same = new Date(Date.now() + 60_000).toISOString();
    const later = new Date(Date.now() + 600_000).toISOString();
    const a = makeApproval({ expiresAt: same });
    const b = makeApproval({ expiresAt: later });
    const c = makeApproval({ expiresAt: same });
    expect(sortRows([b, a, c], 'expiringSoonest').map((r) => r.id)).toEqual([a.id, c.id, b.id]);
  });

  it('orders newest-first by createdAt', () => {
    const old = makeApproval({ createdAt: new Date(Date.now() - 60_000).toISOString() });
    const fresh = makeApproval({ createdAt: new Date().toISOString() });
    expect(sortRows([old, fresh], 'newest').map((r) => r.id)).toEqual([fresh.id, old.id]);
  });
});

describe('matchesSearch', () => {
  const row = makeApproval({
    actionLabel: 'Restart Print Spooler',
    targetDevice: { id: 'd1', hostname: 'WS-ACCT-04' },
    agentName: 'Patch Hygiene Agent',
  });

  it('matches an empty query', () => {
    expect(matchesSearch(row, '')).toBe(true);
  });

  it.each(['spooler', 'ws-acct', 'hygiene'])('matches %s case-insensitively', (q) => {
    expect(matchesSearch(row, q)).toBe(true);
  });

  it('does not match an unrelated needle', () => {
    expect(matchesSearch(row, 'defrag')).toBe(false);
  });
});

describe('buildOrgOptions', () => {
  it('counts rows per org in first-appearance order', () => {
    const rows = [
      makeApproval({ orgId: 'org-a', orgName: 'Acme' }),
      makeApproval({ orgId: 'org-b', orgName: 'Beta' }),
      makeApproval({ orgId: 'org-a', orgName: 'Acme' }),
    ];
    expect(buildOrgOptions(rows, 'Unknown organization')).toEqual([
      { key: 'org-a', name: 'Acme', count: 2 },
      { key: 'org-b', name: 'Beta', count: 1 },
    ]);
  });

  it('folds null-org rows under one synthetic option', () => {
    const rows = [makeApproval({ orgId: null, orgName: null }), makeApproval({ orgId: null, orgName: null })];
    expect(buildOrgOptions(rows, 'Unknown organization')).toEqual([
      { key: '', name: 'Unknown organization', count: 2 },
    ]);
  });
});

describe('groupHostnameSummary', () => {
  it('returns null when no member carries a hostname', () => {
    expect(groupHostnameSummary([makeApproval({ targetDevice: null })])).toBeNull();
  });

  it('caps the shown names and folds the remainder into a count', () => {
    const members = Array.from({ length: GROUP_HOSTNAME_MAX_SHOWN + 3 }, (_, i) =>
      makeApproval({ targetDevice: { id: `d${i}`, hostname: `host-${i}` } }),
    );
    const summary = groupHostnameSummary(members);
    expect(summary?.shown).toHaveLength(GROUP_HOSTNAME_MAX_SHOWN);
    expect(summary?.more).toBe(3);
  });

  it('counts a member with no hostname toward "+K more" rather than dropping it', () => {
    const summary = groupHostnameSummary([
      makeApproval({ targetDevice: { id: 'd1', hostname: 'host-1' } }),
      makeApproval({ targetDevice: null }),
    ]);
    expect(summary).toEqual({ shown: ['host-1'], more: 1 });
  });
});

describe('isExpired', () => {
  const now = Date.parse('2026-09-03T12:00:00.000Z');

  it('is true once the deadline has passed', () => {
    expect(isExpired('2026-09-03T11:59:59.000Z', now)).toBe(true);
  });

  it('is false while time remains', () => {
    expect(isExpired('2026-09-03T12:00:01.000Z', now)).toBe(false);
  });

  it('is false for an unparseable timestamp rather than treating it as expired', () => {
    expect(isExpired('not-a-date', now)).toBe(false);
  });
});
