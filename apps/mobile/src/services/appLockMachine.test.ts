import { describe, expect, it } from 'vitest';

import {
  initialLockState,
  reduceLock,
  type AppLifecycle,
  type LockEvent,
  type LockMachineState,
} from './appLockMachine';
import { LOCK_GRACE_MS, type AppLockState } from './appLockState';

const T0 = 1_800_000_000_000;

/** Drive a sequence of events from the initial state, keeping every write. */
function run(events: LockEvent[], from: LockMachineState = initialLockState) {
  const writes: AppLockState[] = [];
  let state = from;
  for (const event of events) {
    const result = reduceLock(state, event, LOCK_GRACE_MS);
    state = result.state;
    if (result.persist) writes.push(result.persist);
  }
  return { state, writes, lastWrite: writes[writes.length - 1] };
}

const boot = (record: AppLockState | null, lifecycle: AppLifecycle, now = T0): LockEvent => ({
  type: 'bootResolved',
  record,
  lifecycle,
  now,
});
const life = (prev: AppLifecycle, next: AppLifecycle, now: number): LockEvent => ({
  type: 'lifecycle',
  prev,
  next,
  now,
});

describe('cold launch', () => {
  it('locks when there is no persisted record', () => {
    const { state } = run([boot(null, 'active')]);
    expect(state.phase).toBe('locked');
  });

  it('does not lock inside the grace window', () => {
    const { state } = run([boot({ stampedAt: T0 - 1_000, locked: false }, 'active')]);
    expect(state.phase).toBe('unlocked');
  });

  it('locks past the grace window', () => {
    const { state } = run([boot({ stampedAt: T0 - LOCK_GRACE_MS, locked: false }, 'active')]);
    expect(state.phase).toBe('locked');
  });

  it('makes the lock durable immediately instead of waiting for a lifecycle event', () => {
    // A force-quit at the lock screen may never deliver another AppState event,
    // so the record has to say `locked` before then.
    const { lastWrite } = run([boot(null, 'active')]);
    expect(lastWrite).toEqual({ stampedAt: T0, locked: true });
  });

  it('writes nothing when it decides not to lock', () => {
    const { writes } = run([boot({ stampedAt: T0 - 1_000, locked: false }, 'active')]);
    expect(writes).toEqual([]);
  });

  it('runs at most once per process', () => {
    // A second session in the same process is an interactive sign-in, not a
    // cold launch — re-running the check would lock a user who just signed in.
    const { state } = run([
      boot({ stampedAt: T0 - 1_000, locked: false }, 'active'),
      { type: 'signedOut' },
      boot(null, 'active', T0 + 5_000),
    ]);
    expect(state.phase).toBe('unlocked');
  });

  it('covers the UI while a session is restoring but not once resolved', () => {
    expect(initialLockState.phase).toBe('booting');
    const { state } = run([boot({ stampedAt: T0 - 1_000, locked: false }, 'active')]);
    expect(state.phase).toBe('unlocked');
    expect(state.obscured).toBe(false);
  });

  it('keeps a lock decided by a lifecycle event that landed mid-read', () => {
    // The read's verdict must not be able to *undo* a lock, only add one.
    const { state } = run([
      life('active', 'background', T0 - LOCK_GRACE_MS * 2),
      life('background', 'active', T0),
      boot({ stampedAt: T0 - 1_000, locked: false }, 'active', T0),
    ]);
    expect(state.phase).toBe('locked');
  });
});

describe('cold launch into the background', () => {
  // The bypass: a process launched straight into the background (push wake, iOS
  // prewarm) never observes an `active` -> `background` transition, so it has no
  // `backgroundedAt` of its own. Before seeding, its first foregrounding found
  // nothing to measure and opened the fleet however many hours later.
  it('seeds the idle clock from the record so a later foregrounding still locks', () => {
    const { state } = run([
      // Woken 30s after the user backgrounded it — correctly does not lock yet.
      boot({ stampedAt: T0, locked: false }, 'background', T0 + 30_000),
      // ...then sits in the background for six hours and the icon is tapped.
      life('background', 'active', T0 + 6 * 60 * 60 * 1000),
    ]);
    expect(state.phase).toBe('locked');
  });

  it('still honours the grace window for a genuinely quick return', () => {
    const { state } = run([
      boot({ stampedAt: T0, locked: false }, 'background', T0 + 1_000),
      life('background', 'active', T0 + 2_000),
    ]);
    expect(state.phase).toBe('unlocked');
  });

  it('prefers the older of the seeded and observed timestamps', () => {
    // A transition already seen in this process must not be able to shorten the
    // window below what the record proves.
    const { state } = run([
      life('active', 'background', T0 + 50_000),
      boot({ stampedAt: T0, locked: false }, 'background', T0 + 50_001),
      // Past the grace window measured from the record (61s), well inside it
      // measured from the transition this process happened to see (11s).
      life('background', 'active', T0 + 61_000),
    ]);
    expect(state.phase).toBe('locked');
  });

  it('does not seed when the process launched into the foreground', () => {
    // Seeding an active launch would make a brief Face ID sheet (active ->
    // inactive -> active) measure from the stale record and lock spuriously.
    const { state } = run([
      boot({ stampedAt: T0 - 59_000, locked: false }, 'active', T0),
      life('active', 'inactive', T0 + 100),
      life('inactive', 'active', T0 + 200),
    ]);
    expect(state.phase).toBe('unlocked');
  });

  it('covers the UI when the process launched outside the foreground', () => {
    const { state } = run([boot({ stampedAt: T0, locked: false }, 'background', T0 + 1_000)]);
    expect(state.obscured).toBe(true);
  });
});

describe('resume', () => {
  it('locks at exactly the grace boundary, matching the cold-launch rule', () => {
    // The two paths must not disagree at the boundary, or the same gesture
    // behaves differently depending on whether iOS kept the process alive.
    const { state } = run([
      boot({ stampedAt: T0 - 1_000, locked: false }, 'active'),
      life('active', 'background', T0),
      life('background', 'active', T0 + LOCK_GRACE_MS),
    ]);
    expect(state.phase).toBe('locked');
  });

  it('does not lock one millisecond inside the boundary', () => {
    const { state } = run([
      boot({ stampedAt: T0 - 1_000, locked: false }, 'active'),
      life('active', 'background', T0),
      life('background', 'active', T0 + LOCK_GRACE_MS - 1),
    ]);
    expect(state.phase).toBe('unlocked');
  });

  it('clears a stale unlock failure when it re-locks', () => {
    const { state } = run([
      boot(null, 'active'),
      { type: 'unlockRejected' },
      { type: 'unlockSucceeded', now: T0 },
      life('active', 'background', T0 + 1),
      life('background', 'active', T0 + 1 + LOCK_GRACE_MS),
    ]);
    expect(state.phase).toBe('locked');
    expect(state.unlockFailed).toBe(false);
  });
});

describe('inactive must never start the lock clock', () => {
  // The Face ID sheet itself flips the app to `inactive`. If that armed the
  // lock, unlocking would re-arm it — an infinite biometric prompt loop that
  // makes the app unusable for everyone, not just an edge case.
  it('does not lock after a long stretch of bare inactive', () => {
    const { state } = run([
      boot({ stampedAt: T0 - 1_000, locked: false }, 'active'),
      life('active', 'inactive', T0),
      life('inactive', 'active', T0 + LOCK_GRACE_MS * 10),
    ]);
    expect(state.phase).toBe('unlocked');
  });

  it('does not restart the clock on background -> inactive -> background', () => {
    // Only the FIRST entry into background starts it; a later `inactive` in the
    // same excursion must not push the timestamp forward.
    const { state } = run([
      boot({ stampedAt: T0 - 1_000, locked: false }, 'active'),
      life('active', 'background', T0),
      life('background', 'inactive', T0 + LOCK_GRACE_MS - 1),
      life('inactive', 'active', T0 + LOCK_GRACE_MS),
    ]);
    expect(state.phase).toBe('locked');
  });

  it('still raises the privacy cover on inactive', () => {
    const { state } = run([
      boot({ stampedAt: T0 - 1_000, locked: false }, 'active'),
      life('active', 'inactive', T0),
    ]);
    expect(state.obscured).toBe(true);
  });
});

describe('what reaches the keychain', () => {
  it('stamps locked while the cold-launch check is still undecided', () => {
    // Backgrounding during the keychain read must not stamp "unlocked" over a
    // launch that was about to lock — a force-quit there would relaunch in.
    const { lastWrite } = run([life('active', 'background', T0)]);
    expect(lastWrite).toEqual({ stampedAt: T0, locked: true });
  });

  it('stamps locked on every transition while the lock screen is up', () => {
    const { writes } = run([
      boot(null, 'active'),
      life('active', 'inactive', T0 + 1),
      life('inactive', 'background', T0 + 2),
    ]);
    expect(writes.every((w) => w.locked)).toBe(true);
  });

  it('stamps unlocked only after a real unlock', () => {
    const { lastWrite } = run([
      boot(null, 'active'),
      { type: 'unlockSucceeded', now: T0 + 500 },
    ]);
    expect(lastWrite).toEqual({ stampedAt: T0 + 500, locked: false });
  });

  it('re-stamps on resume so a later kill is measured from now', () => {
    const { lastWrite } = run([
      boot({ stampedAt: T0 - 1_000, locked: false }, 'active'),
      life('active', 'background', T0),
      life('background', 'active', T0 + 1_000),
    ]);
    expect(lastWrite).toEqual({ stampedAt: T0 + 1_000, locked: false });
  });

  it('never writes an unlocked record from a phase the user was not given', () => {
    // The whole contract in one assertion: sweep every event from every phase
    // and prove `locked: false` only ever escapes from `unlocked`.
    const phases: LockPhaseFixture[] = [
      { label: 'booting', state: initialLockState },
      { label: 'locked', state: run([boot(null, 'active')]).state },
      {
        label: 'unlocked',
        state: run([boot({ stampedAt: T0 - 1_000, locked: false }, 'active')]).state,
      },
    ];
    const events: LockEvent[] = [
      life('active', 'inactive', T0),
      life('active', 'background', T0),
      life('background', 'active', T0),
      { type: 'signOutRequested', now: T0 },
      { type: 'noAuthenticator' },
      { type: 'authenticatorUnavailable' },
      { type: 'unlockRejected' },
    ];

    const violations: string[] = [];
    for (const { label, state } of phases) {
      for (const event of events) {
        const { persist } = reduceLock(state, event, LOCK_GRACE_MS);
        if (persist && !persist.locked && label !== 'unlocked') {
          violations.push(`${label} + ${event.type}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

interface LockPhaseFixture {
  label: string;
  state: LockMachineState;
}

describe('no authenticator on the device', () => {
  it('unlocks rather than stranding the user', () => {
    const { state } = run([boot(null, 'active'), { type: 'noAuthenticator' }]);
    expect(state.phase).toBe('unlocked');
  });

  it('persists NOTHING, so the concession does not outlive the process', () => {
    // No authentication happened. Writing an unlocked record here would let a
    // transient "no authenticator" answer unlock every future launch too.
    const { writes } = run([boot(null, 'active'), { type: 'noAuthenticator' }]);
    expect(writes).toEqual([{ stampedAt: T0, locked: true }]);
  });
});

describe('device-security check failure', () => {
  it('stays locked instead of treating an unanswered check as "no authenticator"', () => {
    const { state } = run([boot(null, 'active'), { type: 'authenticatorUnavailable' }]);
    expect(state.phase).toBe('locked');
    expect(state.authUnavailable).toBe(true);
  });

  it('is cleared by a successful unlock', () => {
    const { state } = run([
      boot(null, 'active'),
      { type: 'authenticatorUnavailable' },
      { type: 'unlockSucceeded', now: T0 },
    ]);
    expect(state.authUnavailable).toBe(false);
    expect(state.phase).toBe('unlocked');
  });
});

describe('sign out from the lock screen', () => {
  // Clearing the lock optimistically revealed the fleet and every pending
  // approval while the token was still live — up to the 15s fetch timeout on a
  // stalled link — and backgrounding in that window stamped the app unlocked.
  it('keeps the lock up until the session is actually gone', () => {
    const { state } = run([boot(null, 'active'), { type: 'signOutRequested', now: T0 }]);
    expect(state.phase).toBe('locked');
    expect(state.signingOut).toBe(true);
  });

  it('stamps locked, so a force-quit mid-sign-out cannot relaunch unlocked', () => {
    const { lastWrite } = run([
      boot({ stampedAt: T0 - 1_000, locked: false }, 'active'),
      { type: 'signOutRequested', now: T0 },
    ]);
    expect(lastWrite).toEqual({ stampedAt: T0, locked: true });
  });

  it('keeps stamping locked if the app is backgrounded while signing out', () => {
    const { lastWrite } = run([
      boot({ stampedAt: T0 - 1_000, locked: false }, 'active'),
      { type: 'signOutRequested', now: T0 },
      life('active', 'background', T0 + 100),
    ]);
    expect(lastWrite).toEqual({ stampedAt: T0 + 100, locked: true });
  });

  it('releases the lock once the session is gone, without covering the login screen', () => {
    const { state } = run([
      boot(null, 'active'),
      { type: 'signOutRequested', now: T0 },
      { type: 'signedOut' },
    ]);
    expect(state.phase).toBe('unlocked');
    expect(state.obscured).toBe(false);
    expect(state.signingOut).toBe(false);
  });
});

describe('unlock attempts', () => {
  it('a rejected unlock stays locked and shows the retry copy', () => {
    const { state } = run([boot(null, 'active'), { type: 'unlockRejected' }]);
    expect(state.phase).toBe('locked');
    expect(state.unlockFailed).toBe(true);
  });

  it('a rejected unlock writes nothing', () => {
    const before = run([boot(null, 'active')]);
    const { persist } = reduceLock(before.state, { type: 'unlockRejected' }, LOCK_GRACE_MS);
    expect(persist).toBeNull();
  });

  it('a successful unlock clears the failure flag', () => {
    const { state } = run([
      boot(null, 'active'),
      { type: 'unlockRejected' },
      { type: 'unlockSucceeded', now: T0 },
    ]);
    expect(state.phase).toBe('unlocked');
    expect(state.unlockFailed).toBe(false);
  });
});
