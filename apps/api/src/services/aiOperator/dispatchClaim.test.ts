import { describe, it, expect, vi } from 'vitest';

// The module under test only needs its PURE predicate here, but importing it
// pulls in `../../db` (a real postgres pool at import time). Stub it: nothing
// in these cases touches the database.
vi.mock('../../db', () => ({
  db: {},
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));

import { evaluateTaskClaimPredicate, type ClaimTaskSnapshot } from './dispatchClaim';

const NOW = new Date('2026-10-14T12:00:00.000Z');
const FUTURE = new Date('2026-10-14T13:00:00.000Z');
const PAST = new Date('2026-10-14T11:00:00.000Z');

function task(overrides: Partial<ClaimTaskSnapshot> = {}): ClaimTaskSnapshot {
  return {
    state: 'running',
    revision: 3,
    leaseEpoch: 7,
    deadlineAt: FUTURE,
    targetDetachedAt: null,
    ...overrides,
  };
}

describe('evaluateTaskClaimPredicate (spec §7.3 dispatch claim)', () => {
  it('permits a claim on a live, in-revision, in-deadline, attached task', () => {
    expect(evaluateTaskClaimPredicate(task(), 3, { now: NOW })).toBeNull();
  });

  it("permits a claim while the task is 'waiting' — the approval case the slice exists for", () => {
    expect(evaluateTaskClaimPredicate(task({ state: 'waiting' }), 3, { now: NOW })).toBeNull();
  });

  // The refusal table. Each row names a state a task can be in that must NOT
  // admit a new effect (spec §7.3: "No new effect may claim while paused,
  // stopping, expired, handed_off, or otherwise terminal").
  it.each([
    ['paused', 'paused'],
    ['stopping', 'stopping'],
    ['queued', 'queued'],
    ['completed', 'completed'],
    ['cancelled', 'cancelled'],
    ['failed', 'failed'],
    ['expired', 'expired'],
    ['handed_off', 'handed_off'],
    ['partial', 'partial'],
  ])('refuses a claim while the task is %s', (_label, state) => {
    const refusal = evaluateTaskClaimPredicate(task({ state }), 3, { now: NOW });
    expect(refusal).toContain('cannot admit a new effect');
  });

  it('refuses when the plan revision moved after approval (spec §7.1)', () => {
    // The operation pinned revision 3 at reservation; the task is now on 4.
    expect(evaluateTaskClaimPredicate(task({ revision: 4 }), 3, { now: NOW }))
      .toContain('plan revision moved');
  });

  it('refuses when the operation never pinned a plan revision', () => {
    expect(evaluateTaskClaimPredicate(task(), null, { now: NOW }))
      .toContain('plan revision moved');
  });

  it('refuses when the task deadline has passed', () => {
    expect(evaluateTaskClaimPredicate(task({ deadlineAt: PAST }), 3, { now: NOW }))
      .toContain('deadline has passed');
  });

  it('refuses at exactly the deadline instant — the bound is exclusive', () => {
    expect(evaluateTaskClaimPredicate(task({ deadlineAt: NOW }), 3, { now: NOW }))
      .toContain('deadline has passed');
  });

  // FAIL CLOSED. A nullable column read into a WHERE clause silently refusing
  // is not the same as a deliberate refusal, and this is the deliberate one:
  // absence of a bound is not permission to act indefinitely.
  it('refuses when the task has no deadline at all', () => {
    expect(evaluateTaskClaimPredicate(task({ deadlineAt: null }), 3, { now: NOW }))
      .toContain('no deadline_at');
  });

  it('refuses when the target has been detached (device moved or deleted)', () => {
    expect(evaluateTaskClaimPredicate(task({ targetDetachedAt: PAST }), 3, { now: NOW }))
      .toContain('target is detached');
  });

  describe('lease epoch', () => {
    it('does not fence when the caller supplies no expectation (the intent-release path)', () => {
      // Spec §6.3: a coordinator takeover while a human was deciding must not
      // strand the approval. The release worker holds no lease, so it passes
      // none, and the intent CAS is its fence.
      expect(evaluateTaskClaimPredicate(task({ leaseEpoch: 99 }), 3, { now: NOW })).toBeNull();
      expect(
        evaluateTaskClaimPredicate(task({ leaseEpoch: 99 }), 3, { now: NOW, expectedLeaseEpoch: null }),
      ).toBeNull();
    });

    it('fences a lease holder whose epoch was superseded', () => {
      expect(
        evaluateTaskClaimPredicate(task({ leaseEpoch: 8 }), 3, { now: NOW, expectedLeaseEpoch: 7 }),
      ).toContain('lease epoch moved');
    });

    it('permits a lease holder whose epoch still matches', () => {
      expect(
        evaluateTaskClaimPredicate(task({ leaseEpoch: 7 }), 3, { now: NOW, expectedLeaseEpoch: 7 }),
      ).toBeNull();
    });

    it('fences epoch 0 rather than treating it as "no expectation"', () => {
      // `lease_epoch` defaults to 0, so a falsy-check here would silently
      // disable fencing for every freshly-admitted task.
      expect(
        evaluateTaskClaimPredicate(task({ leaseEpoch: 1 }), 3, { now: NOW, expectedLeaseEpoch: 0 }),
      ).toContain('lease epoch moved');
    });
  });
});
