import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ db: {} }));
vi.mock('../db/schema', () => ({ patchApprovals: {} }));

import { resolveLatestManualDecisions, type ManualDecisionRow } from './patchManualDecisions';

const P = 'patch-1';
const RING = 'ring-a';
const OTHER = 'ring-b';
const row = (status: string, ringId: string | null, day: number | null): ManualDecisionRow => ({
  patchId: P,
  status,
  ringId,
  updatedAt: day === null ? null : new Date(Date.UTC(2026, 9, day)),
});

describe('resolveLatestManualDecisions', () => {
  it('a blanket approval alone approves', () => {
    const r = resolveLatestManualDecisions([row('approved', null, 1)], 'any');
    expect([...r.approved]).toEqual([P]);
    expect(r.declined.size).toBe(0);
  });

  it('a newer ring decline beats an older blanket approval (ring-agnostic)', () => {
    const r = resolveLatestManualDecisions([row('approved', null, 1), row('rejected', RING, 2)], 'any');
    expect(r.approved.size).toBe(0);
    expect([...r.declined]).toEqual([P]);
  });

  it('a newer approval re-approves over an older decline', () => {
    const r = resolveLatestManualDecisions([row('rejected', RING, 1), row('approved', null, 2)], 'any');
    expect([...r.approved]).toEqual([P]);
  });

  it('a tie resolves to the decline, as does a missing timestamp', () => {
    expect(resolveLatestManualDecisions([row('approved', null, 1), row('rejected', RING, 1)], 'any').declined.has(P)).toBe(true);
    expect(resolveLatestManualDecisions([row('approved', null, null), row('rejected', RING, null)], 'any').declined.has(P)).toBe(true);
  });

  it("'any' is latest-wins across rings: a newer approval supersedes an older ring decline", () => {
    const r = resolveLatestManualDecisions([row('rejected', RING, 1), row('approved', OTHER, 2)], 'any');
    expect(r.approved.has(P)).toBe(true);
  });

  it('a ring scope ignores other rings but keeps partner-wide rows', () => {
    const rows = [row('approved', null, 1), row('rejected', OTHER, 2)];
    expect(resolveLatestManualDecisions(rows, { ringId: RING }).approved.has(P)).toBe(true);
    expect(resolveLatestManualDecisions(rows, { ringId: OTHER }).declined.has(P)).toBe(true);
  });

  it('ignores statuses other than approved/rejected', () => {
    const r = resolveLatestManualDecisions([row('pending', null, 5)], 'any');
    expect(r.approved.size + r.declined.size).toBe(0);
  });
});
