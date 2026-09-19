import { describe, expect, it } from 'vitest';
import { pickWinner, type MonitorCandidate } from './monitorResolver';

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
