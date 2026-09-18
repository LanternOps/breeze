import { describe, it, expect } from 'vitest';
import {
  MFA_ENROLLMENT_GRACE_DAYS_DEFAULT,
  MFA_ENROLLMENT_GRACE_DAYS_MAX,
  evaluateMfaEnrollmentGrace,
  previewMfaEnrollmentGrace,
  resolveMfaGraceDays,
} from './mfaEnrollmentGrace';

/**
 * The happy paths (grant, stability, shortening, the mfa_epoch gate) are proven
 * against real Postgres in
 * `src/__tests__/integration/mfaEnrollmentGrace.integration.test.ts` — SQL
 * semantics and the DB clock cannot be mocked honestly.
 *
 * What is unit-testable, and is what this file covers, is the RACE-LOSS
 * disposition: what the resolver concludes when its conditional grant UPDATE
 * affects zero rows. That branch is reachable in production (two logins landing
 * together, or a factor enrolled between the read and the UPDATE) but cannot be
 * scheduled deterministically against a real database.
 */

type Row = Record<string, unknown>;

/** Stub executor returning a scripted result per `execute` call, in order. */
function scriptedExec(results: Row[][]) {
  const calls: string[] = [];
  let i = 0;
  return {
    calls,
    exec: {
      execute: async (query: { queryChunks?: unknown[] }) => {
        calls.push(JSON.stringify(query?.queryChunks ?? '').slice(0, 40));
        const next = results[i] ?? [];
        i += 1;
        return next;
      },
    } as Parameters<typeof evaluateMfaEnrollmentGrace>[2],
    get callCount() {
      return i;
    },
  };
}

const factorless = (overrides: Row = {}): Row => ({
  mfa_enabled: false,
  mfa_epoch: 1,
  passkey_count: 0,
  deadline: null,
  granted_at: null,
  db_now: new Date('2026-10-16T12:00:00Z'),
  ...overrides,
});

describe('resolveMfaGraceDays', () => {
  it('defaults when unset or not a finite number, and clamps into [0, MAX]', () => {
    expect(resolveMfaGraceDays(undefined)).toBe(MFA_ENROLLMENT_GRACE_DAYS_DEFAULT);
    expect(resolveMfaGraceDays({})).toBe(MFA_ENROLLMENT_GRACE_DAYS_DEFAULT);
    expect(resolveMfaGraceDays({ mfaEnrollmentGraceDays: Number.NaN })).toBe(MFA_ENROLLMENT_GRACE_DAYS_DEFAULT);
    expect(resolveMfaGraceDays({ mfaEnrollmentGraceDays: -5 })).toBe(0);
    expect(resolveMfaGraceDays({ mfaEnrollmentGraceDays: 0 })).toBe(0);
    expect(resolveMfaGraceDays({ mfaEnrollmentGraceDays: 7.9 })).toBe(7);
    expect(resolveMfaGraceDays({ mfaEnrollmentGraceDays: 999 })).toBe(MFA_ENROLLMENT_GRACE_DAYS_MAX);
  });
});

describe('evaluateMfaEnrollmentGrace — race-loss disposition', () => {
  it('reports hasFactor when the grant lost the race because a factor was enrolled meanwhile', async () => {
    // A partial re-read (timestamps only) would keep answering hasFactor:false
    // for a user who now holds a factor — and the policy would then treat them
    // as "still deciding" rather than protected.
    const scripted = scriptedExec([
      [factorless()],                                   // initial read: no factor, no grant
      [],                                               // grant UPDATE: zero rows
      [factorless({ mfa_enabled: true, mfa_epoch: 2 })], // re-read: they just enrolled
    ]);

    const facts = await evaluateMfaEnrollmentGrace('u1', 14, scripted.exec);

    expect(facts).toEqual({ hasFactor: true, deadline: null, expired: false });
    expect(scripted.callCount).toBe(3);
  });

  it('honours the winner’s persisted deadline rather than granting a second window', async () => {
    const grantedAt = new Date('2026-10-16T12:00:00Z');
    const deadline = new Date('2026-10-30T12:00:00Z');
    const scripted = scriptedExec([
      [factorless()],
      [],
      [factorless({ deadline, granted_at: grantedAt, db_now: new Date('2026-10-17T12:00:00Z') })],
    ]);

    const facts = await evaluateMfaEnrollmentGrace('u1', 14, scripted.exec);

    expect(facts.hasFactor).toBe(false);
    expect(facts.deadline?.toISOString()).toBe(deadline.toISOString());
    expect(facts.expired).toBe(false);
  });

  it('throws rather than reporting "no window" when the row has vanished mid-flight', async () => {
    const scripted = scriptedExec([
      [factorless()],
      [], // grant affected nothing…
      [], // …and the row is gone (concurrent erasure)
    ]);

    await expect(evaluateMfaEnrollmentGrace('u1', 14, scripted.exec)).rejects.toThrow(/no users row/);
  });

  it('throws on a missing row before attempting any grant', async () => {
    const scripted = scriptedExec([[]]);

    await expect(evaluateMfaEnrollmentGrace('u1', 14, scripted.exec)).rejects.toThrow(/no users row/);
    expect(scripted.callCount).toBe(1);
  });

  it('never attempts a grant for an account that has held a factor before', async () => {
    const scripted = scriptedExec([[factorless({ mfa_epoch: 3 })]]);

    const facts = await evaluateMfaEnrollmentGrace('u1', 14, scripted.exec);

    expect(facts).toEqual({ hasFactor: false, deadline: null, expired: false });
    // One statement only: no UPDATE was issued, so no window can be created.
    expect(scripted.callCount).toBe(1);
  });

  it('reports an expired window using the DATABASE clock, not the host clock', async () => {
    const grantedAt = new Date('2026-10-01T12:00:00Z');
    const deadline = new Date('2026-10-15T12:00:00Z');
    const scripted = scriptedExec([
      [factorless({ deadline, granted_at: grantedAt, db_now: new Date('2026-10-16T12:00:00Z') })],
    ]);

    const facts = await evaluateMfaEnrollmentGrace('u1', 14, scripted.exec);

    expect(facts.expired).toBe(true);
    expect(facts.deadline?.toISOString()).toBe(deadline.toISOString());
  });
});

/**
 * #5690 — Admin → Users list MFA status column. `previewMfaEnrollmentGrace`
 * must never write to the DB (it takes no executor at all) and must reproduce
 * `evaluateMfaEnrollmentGrace`'s decision whenever a grant already exists.
 */
describe('previewMfaEnrollmentGrace', () => {
  const now = new Date('2026-11-01T00:00:00Z');

  it('reports enrolled (hasFactor) for an account that already holds a factor', () => {
    const facts = previewMfaEnrollmentGrace({
      hasFactor: true,
      mfaEpoch: 5,
      deadline: null,
      grantedAt: null,
      graceDays: 14,
      now,
    });
    expect(facts).toEqual({ hasFactor: true, deadline: null, expired: false });
  });

  it('gives no window to an account that has ever held a factor (mfa_epoch !== 1)', () => {
    const facts = previewMfaEnrollmentGrace({
      hasFactor: false,
      mfaEpoch: 3,
      deadline: null,
      grantedAt: null,
      graceDays: 14,
      now,
    });
    expect(facts).toEqual({ hasFactor: false, deadline: null, expired: false });
  });

  it('reproduces the persisted grant\'s effective deadline (min of deadline and grantedAt+graceDays)', () => {
    const grantedAt = new Date('2026-10-01T00:00:00Z');
    const deadline = new Date('2026-10-20T00:00:00Z'); // longer than 14 days from grantedAt
    const facts = previewMfaEnrollmentGrace({
      hasFactor: false,
      mfaEpoch: 1,
      deadline,
      grantedAt,
      graceDays: 14,
      now,
    });
    // effective = min(2026-10-20, 2026-10-01 + 14d = 2026-10-15) = 2026-10-15
    expect(facts.deadline?.toISOString()).toBe(new Date('2026-10-15T00:00:00Z').toISOString());
    expect(facts.expired).toBe(true); // now (11-01) is past 10-15
  });

  it('reports NOT expired when the persisted deadline is in the future', () => {
    const grantedAt = new Date('2026-10-25T00:00:00Z');
    const deadline = new Date('2026-11-08T00:00:00Z');
    const facts = previewMfaEnrollmentGrace({
      hasFactor: false,
      mfaEpoch: 1,
      deadline,
      grantedAt,
      graceDays: 14,
      now,
    });
    expect(facts.expired).toBe(false);
    expect(facts.deadline?.toISOString()).toBe(deadline.toISOString());
  });

  it('previews a not-yet-granted window as now + graceDays, never expired', () => {
    const facts = previewMfaEnrollmentGrace({
      hasFactor: false,
      mfaEpoch: 1,
      deadline: null,
      grantedAt: null,
      graceDays: 14,
      now,
    });
    expect(facts.expired).toBe(false);
    expect(facts.deadline?.toISOString()).toBe(new Date('2026-11-15T00:00:00Z').toISOString());
  });

  it('reports a not-yet-granted window as already expired when graceDays is 0 ("0 disables the window")', () => {
    const facts = previewMfaEnrollmentGrace({
      hasFactor: false,
      mfaEpoch: 1,
      deadline: null,
      grantedAt: null,
      graceDays: 0,
      now,
    });
    // A real grant right now would set deadline = grantedAt (no window at
    // all) — never "pending" for a graceDays=0 partner.
    expect(facts.expired).toBe(true);
  });

  it('never issues a DB call — the function signature takes no executor', () => {
    // Compile-time guarantee mostly, but assert the return shape has no
    // promise/thenable leaking through, confirming it's synchronous & pure.
    const result = previewMfaEnrollmentGrace({
      hasFactor: false,
      mfaEpoch: 1,
      deadline: null,
      grantedAt: null,
      graceDays: 5,
      now,
    });
    expect(result).not.toBeInstanceOf(Promise);
  });
});
