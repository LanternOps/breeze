import { describe, expect, it } from 'vitest';

import {
  INSTALL_POLL_MAX_DURATION_MS,
  INSTALL_POLL_SETTLE_MS,
  decideInstallPoll,
  isTerminalCommandStatus,
  snapshotInstallOutcomes,
  type InstallPollState,
} from './patchInstallPolling';

const failure = (failedAt: string) => ({ deviceCount: 1, error: 'boom', failedAt });
const restart = (installedAt: string) => ({ installedAt });

function state(overrides: Partial<InstallPollState> = {}): InstallPollState {
  return {
    startedAt: 0,
    patchIds: ['p1'],
    baseline: new Map([['p1', '|']]),
    settleFrom: null,
    ...overrides,
  };
}

describe('isTerminalCommandStatus', () => {
  it('treats completed, failed, cancelled, timeout and expired as terminal', () => {
    for (const s of ['completed', 'failed', 'cancelled', 'timeout', 'expired']) {
      expect(isTerminalCommandStatus(s)).toBe(true);
    }
  });

  it('keeps pending, sent, running and unknown statuses polling', () => {
    for (const s of ['pending', 'sent', 'running', 'claimed', '', null, undefined]) {
      expect(isTerminalCommandStatus(s)).toBe(false);
    }
  });
});

describe('snapshotInstallOutcomes', () => {
  it('records the failure and restart timestamps of each targeted patch', () => {
    const baseline = snapshotInstallOutcomes(
      [
        { id: 'p1', installFailure: failure('2026-10-01T00:00:00Z') },
        { id: 'p2', awaitingRestart: restart('2026-10-02T00:00:00Z') },
        { id: 'other', installFailure: failure('2026-10-03T00:00:00Z') },
      ],
      ['p1', 'p2'],
    );
    expect(baseline.get('p1')).toBe('2026-10-01T00:00:00Z|');
    expect(baseline.get('p2')).toBe('|2026-10-02T00:00:00Z');
    expect(baseline.has('other')).toBe(false);
  });
});

describe('decideInstallPoll', () => {
  it('keeps polling while the targeted patch is still pending with no new outcome', () => {
    const decision = decideInstallPoll(state(), {
      now: 10_000,
      pending: [{ id: 'p1' }],
      commandStatus: 'sent',
    });
    expect(decision).toEqual({ kind: 'continue', settleFrom: null });
  });

  it('stops as installed once every targeted patch has left the pending list', () => {
    const decision = decideInstallPoll(state({ patchIds: ['p1', 'p2'], baseline: new Map([['p1', '|'], ['p2', '|']]) }), {
      now: 10_000,
      pending: [{ id: 'unrelated' }],
      commandStatus: null,
    });
    expect(decision).toEqual({
      kind: 'done',
      summary: { installed: 2, failed: 0, awaitingRestart: 0, unresolved: 0, pending: 1 },
    });
  });

  // The #10250 bug: a failed install never shrinks the pending list, so the
  // old count-only check spun for 30 minutes.
  it('stops as soon as the targeted patch gains a new install failure', () => {
    const decision = decideInstallPoll(state(), {
      now: 10_000,
      pending: [{ id: 'p1', installFailure: failure('2026-10-28T10:00:00Z') }],
      commandStatus: 'failed',
    });
    expect(decision).toEqual({
      kind: 'done',
      summary: { installed: 0, failed: 1, awaitingRestart: 0, unresolved: 0, pending: 1 },
    });
  });

  it('stops when a Windows install leaves the patch pending but awaiting a restart', () => {
    const decision = decideInstallPoll(state(), {
      now: 10_000,
      pending: [{ id: 'p1', awaitingRestart: restart('2026-10-28T10:00:00Z') }],
      commandStatus: 'completed',
    });
    expect(decision).toEqual({
      kind: 'done',
      summary: { installed: 0, failed: 0, awaitingRestart: 1, unresolved: 0, pending: 1 },
    });
  });

  it('does not count an install failure that was already there before the install', () => {
    const decision = decideInstallPoll(
      state({ baseline: new Map([['p1', '2026-10-01T00:00:00Z|']]) }),
      { now: 10_000, pending: [{ id: 'p1', installFailure: failure('2026-10-01T00:00:00Z') }], commandStatus: 'sent' },
    );
    expect(decision.kind).toBe('continue');
  });

  it('counts a retry that fails again as a new failure', () => {
    const decision = decideInstallPoll(
      state({ baseline: new Map([['p1', '2026-10-01T00:00:00Z|']]) }),
      { now: 10_000, pending: [{ id: 'p1', installFailure: failure('2026-10-28T10:00:00Z') }], commandStatus: 'failed' },
    );
    expect(decision.kind).toBe('done');
  });

  it('waits for the post-install rescan once the command completes', () => {
    const decision = decideInstallPoll(state(), {
      now: 20_000,
      pending: [{ id: 'p1' }],
      commandStatus: 'completed',
    });
    expect(decision).toEqual({ kind: 'continue', settleFrom: 20_000 });
  });

  it('stops with the unresolved patches once the settle window after completion runs out', () => {
    const decision = decideInstallPoll(state({ settleFrom: 20_000 }), {
      now: 20_000 + INSTALL_POLL_SETTLE_MS,
      pending: [{ id: 'p1' }],
      commandStatus: null,
    });
    expect(decision).toEqual({
      kind: 'done',
      summary: { installed: 0, failed: 0, awaitingRestart: 0, unresolved: 1, pending: 1 },
    });
  });

  it('keeps waiting inside the settle window for the rest of a mixed batch', () => {
    const decision = decideInstallPoll(
      state({ patchIds: ['p1', 'p2'], baseline: new Map([['p1', '|'], ['p2', '|']]) }),
      { now: 30_000, pending: [{ id: 'p1', installFailure: failure('2026-10-28T10:00:00Z') }, { id: 'p2' }], commandStatus: 'failed' },
    );
    expect(decision).toEqual({ kind: 'continue', settleFrom: 30_000 });
  });

  it('starts the settle window from the first new outcome when there is no command id', () => {
    const decision = decideInstallPoll(
      state({ patchIds: ['p1', 'p2'], baseline: new Map([['p1', '|'], ['p2', '|']]) }),
      { now: 30_000, pending: [{ id: 'p1', installFailure: failure('2026-10-28T10:00:00Z') }, { id: 'p2' }], commandStatus: null },
    );
    expect(decision).toEqual({ kind: 'continue', settleFrom: 30_000 });
  });

  it('stops immediately when the command is cancelled or expires before the device ran it', () => {
    for (const status of ['cancelled', 'expired', 'timeout']) {
      const decision = decideInstallPoll(state(), { now: 10_000, pending: [{ id: 'p1' }], commandStatus: status });
      expect(decision).toEqual({ kind: 'command_ended', status });
    }
  });

  it('times out after the maximum duration when nothing ever resolves', () => {
    const decision = decideInstallPoll(state(), {
      now: INSTALL_POLL_MAX_DURATION_MS,
      pending: [{ id: 'p1' }],
      commandStatus: 'sent',
    });
    expect(decision).toEqual({ kind: 'timed_out' });
  });
});
