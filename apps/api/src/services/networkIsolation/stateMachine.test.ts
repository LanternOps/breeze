import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ACTIVE_STATES,
  ISOLATION_STATES,
  RESOLVED_TERMINAL_STATES,
  UNRESOLVED_TERMINAL_STATES,
  type IsolationState,
} from '@breeze/shared';
import { applyEpisodeEvent, type EpisodeEvent, type EpisodeSnapshot } from './stateMachine';

const T0 = new Date('2026-10-30T10:00:00.000Z');
const AT = new Date('2026-10-30T10:01:00.000Z');
const EXPIRES = new Date('2026-11-02T10:00:00.000Z');

function snap(overrides: Partial<EpisodeSnapshot> = {}): EpisodeSnapshot {
  return {
    state: 'requested',
    desiredState: 'isolated',
    generation: 1,
    lastJournalSeq: 0,
    failureCode: null,
    releaseKind: null,
    expiresAt: EXPIRES,
    dispatchedAt: null,
    appliedAt: null,
    verifiedAt: null,
    releaseRequestedAt: null,
    releasedAt: null,
    releaseConfirmedAt: null,
    acknowledgedAt: null,
    acknowledgedBy: null,
    ...overrides,
  };
}

const USER_ID = 'b6a8d1f2-3c4e-4f5a-9b6c-7d8e9f0a1b2c';
/** Agent events must carry a journalSeq; tests that do not care get a fresh, always-newer one. */
const SEQ_REQUIRED = new Set<EpisodeEvent['type']>([
  'agent_ack', 'agent_applied', 'agent_verified', 'agent_failed', 'agent_released', 'agent_expired',
  'agent_self_released', 'agent_released_locally',
]);
let autoSeq = 1000;

/** An event at the snapshot's generation unless overridden. */
function ev<E extends EpisodeEvent['type']>(
  type: E,
  extra: Partial<Omit<Extract<EpisodeEvent, { type: E }>, 'type'>> & Record<string, unknown> = {},
): Extract<EpisodeEvent, { type: E }> {
  const seq = SEQ_REQUIRED.has(type) && extra.journalSeq === undefined ? { journalSeq: ++autoSeq } : {};
  const user = type === 'acknowledge' && extra.userId === undefined ? { userId: USER_ID } : {};
  return { type, isolationId: '11111111-1111-4111-8111-111111111111', generation: 1, at: AT, ...seq, ...user, ...extra } as unknown as Extract<EpisodeEvent, { type: E }>;
}

function next(row: EpisodeSnapshot, event: EpisodeEvent): EpisodeSnapshot {
  const out = applyEpisodeEvent(row, event);
  if (!('next' in out)) throw new Error(`expected a transition, got ignored: ${out.ignored}`);
  return out.next;
}

function ignored(row: EpisodeSnapshot, event: EpisodeEvent) {
  const out = applyEpisodeEvent(row, event);
  return 'ignored' in out ? out.ignored : null;
}

const ISOLATED_ACTIVE = ['requested', 'dispatched', 'applying', 'applied', 'verified'] as const;

describe('spec §3.2 arrows', () => {
  it('requested → dispatched (dispatch)', () => {
    const n = next(snap(), ev('dispatched'));
    expect(n).toMatchObject({ state: 'dispatched', generation: 1, dispatchedAt: AT, desiredState: 'isolated' });
  });

  it('dispatched → applying (agent ack)', () => {
    expect(next(snap({ state: 'dispatched' }), ev('agent_ack', { journalSeq: 1 }))).toMatchObject({ state: 'applying', lastJournalSeq: 1 });
  });

  it('applying → applied (rules in place)', () => {
    expect(next(snap({ state: 'applying' }), ev('agent_applied', { journalSeq: 2 }))).toMatchObject({ state: 'applied', appliedAt: AT });
  });

  it('applied → verified (both probes ok)', () => {
    expect(next(snap({ state: 'applied', appliedAt: T0 }), ev('agent_verified', { journalSeq: 3 })))
      .toMatchObject({ state: 'verified', verifiedAt: AT, appliedAt: T0 });
  });

  it('requested → failed:agent_unsupported', () => {
    expect(next(snap(), ev('agent_failed', { code: 'agent_unsupported' })))
      .toMatchObject({ state: 'failed', failureCode: 'agent_unsupported' });
  });

  it('dispatched → failed:not_delivered writes an UNCONFIRMED tombstone at generation + 1', () => {
    const n = next(snap({ state: 'dispatched' }), ev('not_delivered'));
    expect(n).toMatchObject({ state: 'failed', failureCode: 'not_delivered', desiredState: 'released', generation: 2, releaseConfirmedAt: null });
  });

  it.each(['apply_error', 'mechanism_unavailable', 'unsupported_platform'] as const)('applying → failed:%s (rolled back)', (code) => {
    const n = next(snap({ state: 'applying' }), ev('agent_failed', { code, journalSeq: 5 }));
    // The agent reported the rollback: nothing Breeze-owned is installed, so no tombstone is owed.
    expect(n).toMatchObject({ state: 'failed', failureCode: code, desiredState: 'released', generation: 1, releaseConfirmedAt: AT });
  });

  it.each(['control_plane_unreachable', 'enforcement_not_observed'] as const)('applied → failed:%s (probe failed, rolled back)', (code) => {
    expect(next(snap({ state: 'applied' }), ev('agent_failed', { code }))).toMatchObject({ state: 'failed', failureCode: code });
  });

  it('verified → release_requested → released', () => {
    const requested = next(snap({ state: 'verified' }), ev('release_requested', { kind: 'console' }));
    expect(requested).toMatchObject({
      state: 'release_requested', desiredState: 'released', generation: 2, releaseKind: 'console', releaseRequestedAt: AT,
    });
    const released = next(requested, ev('agent_released', { kind: 'console', generation: 2, journalSeq: 9 }));
    expect(released).toMatchObject({ state: 'released', releasedAt: AT, releaseConfirmedAt: AT, releaseKind: 'console', generation: 2 });
  });

  it('verified → expired (agent, offline-safe)', () => {
    expect(next(snap({ state: 'verified' }), ev('agent_expired', { journalSeq: 4 })))
      .toMatchObject({ state: 'expired', releaseKind: 'expired', desiredState: 'released', releasedAt: AT, releaseConfirmedAt: AT });
  });

  it.each(['local_code', 'local_forced'] as const)('verified → released_locally (%s)', (kind) => {
    expect(next(snap({ state: 'verified' }), ev('agent_released_locally', { kind, journalSeq: 4 })))
      .toMatchObject({ state: 'released_locally', releaseKind: kind, desiredState: 'released', releaseConfirmedAt: AT });
  });

  it('verified → self_released (opt-in dead-man)', () => {
    expect(next(snap({ state: 'verified' }), ev('agent_self_released', { journalSeq: 4 })))
      .toMatchObject({ state: 'self_released', releaseKind: 'dead_man', releaseConfirmedAt: AT });
  });

  it('verified → uninstalled', () => {
    expect(next(snap({ state: 'verified' }), ev('uninstalled')))
      .toMatchObject({ state: 'uninstalled', releaseKind: 'uninstall', desiredState: 'released', releaseConfirmedAt: AT });
  });

  it.each(UNRESOLVED_TERMINAL_STATES)('%s → acknowledge resolves to released', (state) => {
    const row = snap({ state, desiredState: 'released', releaseKind: state === 'self_released' ? 'dead_man' : 'local_code', releaseConfirmedAt: T0 });
    const n = next(row, ev('acknowledge', { userId: USER_ID }));
    expect(n).toMatchObject({ state: 'released', acknowledgedAt: AT, acknowledgedBy: USER_ID, releaseKind: row.releaseKind });
  });

  it('acknowledge at a stale generation is stale_generation (it cannot resolve a newer episode state)', () => {
    const row = snap({ state: 'released_locally', desiredState: 'released', generation: 3, releaseKind: 'local_forced', releaseConfirmedAt: T0 });
    expect(ignored(row, ev('acknowledge', { generation: 2 }))).toBe('stale_generation');
  });
});

describe('arrows the spec does not draw', () => {
  it('a verified episode cannot fail, and neither can a pending release', () => {
    expect(ignored(snap({ state: 'verified' }), ev('agent_failed', { code: 'enforcement_not_observed' }))).toBe('invalid_transition');
    expect(ignored(snap({ state: 'release_requested', desiredState: 'released' }), ev('agent_failed', { code: 'apply_error' })))
      .toBe('invalid_transition');
  });

  it('extend refuses an invalid date and a pending release', () => {
    expect(ignored(snap({ state: 'verified' }), ev('extend', { expiresAt: new Date('nope') }))).toBe('invalid_transition');
    expect(ignored(snap({ state: 'release_requested', desiredState: 'released' }), ev('extend', { expiresAt: EXPIRES })))
      .toBe('invalid_transition');
  });

  it('a stale absence report cannot confirm an owed tombstone', () => {
    const undelivered = snap({ state: 'failed', failureCode: 'not_delivered', desiredState: 'released', generation: 2, lastJournalSeq: 9 });
    expect(ignored(undelivered, ev('agent_absent', { generation: 1 }))).toBe('stale_generation');
    expect(ignored(undelivered, ev('agent_absent', { generation: 2, journalSeq: 9 }))).toBe('stale_seq');
    expect(next(undelivered, ev('agent_absent', { generation: 2, journalSeq: 10 }))).toMatchObject({ releaseConfirmedAt: AT, lastJournalSeq: 10 });
  });

  it('keeps only snapshot fields when handed a wider row', () => {
    const wide = { ...snap({ state: 'verified' }), id: 'row-id', orgId: 'org-id', breakGlassSecretEnc: 'ciphertext' };
    const n = next(wide, ev('release_requested', { kind: 'console' }));
    expect(Object.keys(n).sort()).toEqual(Object.keys(snap()).sort());
  });
});

describe('plan W1a Task 3 cases', () => {
  it('extend increments the generation and moves expiresAt', () => {
    const later = new Date('2026-11-05T10:00:00.000Z');
    expect(next(snap({ state: 'verified' }), ev('extend', { expiresAt: later }))).toMatchObject({ state: 'verified', generation: 2, expiresAt: later });
  });

  it('a retransmission keeps the generation', () => {
    for (const state of ['dispatched', 'applying', 'applied', 'verified'] as const) {
      const row = snap({ state, generation: 3, dispatchedAt: T0 });
      const n = next(row, ev('dispatched', { generation: 3 }));
      expect(n, state).toEqual(row);
    }
    const tombstone = snap({ state: 'release_requested', desiredState: 'released', generation: 4, releaseKind: 'console', releaseRequestedAt: T0 });
    expect(next(tombstone, ev('release_requested', { kind: 'ai', generation: 4 }))).toEqual(tombstone);
  });

  it.each(ACTIVE_STATES.filter((s) => s !== 'release_requested'))("release from %s sets desired 'released' at generation + 1", (state) => {
    expect(next(snap({ state, generation: 5 }), ev('release_requested', { kind: 'system', generation: 5 })))
      .toMatchObject({ state: 'release_requested', desiredState: 'released', generation: 6, releaseKind: 'system' });
  });

  it('a lower generation is stale_generation', () => {
    expect(ignored(snap({ state: 'verified', generation: 3 }), ev('agent_verified', { generation: 2, journalSeq: 10 }))).toBe('stale_generation');
    expect(ignored(snap({ state: 'release_requested', desiredState: 'released', generation: 2 }), ev('agent_released', { kind: 'console', generation: 1 })))
      .toBe('stale_generation');
  });

  it('a journalSeq at or below last_journal_seq is stale_seq', () => {
    const row = snap({ state: 'applying', lastJournalSeq: 7 });
    expect(ignored(row, ev('agent_applied', { journalSeq: 7 }))).toBe('stale_seq');
    expect(ignored(row, ev('agent_applied', { journalSeq: 6 }))).toBe('stale_seq');
    expect(next(row, ev('agent_applied', { journalSeq: 8 }))).toMatchObject({ state: 'applied', lastJournalSeq: 8 });
  });

  it.each(RESOLVED_TERMINAL_STATES)('every event after %s is already_terminal (agent_absent only confirms)', (state) => {
    const row = snap({
      state, desiredState: 'released', failureCode: state === 'failed' ? 'apply_error' : null, releaseConfirmedAt: T0,
    });
    const events: EpisodeEvent[] = [
      ev('dispatched'), ev('agent_ack', { journalSeq: 50 }), ev('agent_applied', { journalSeq: 51 }),
      ev('agent_verified', { journalSeq: 52 }), ev('agent_failed', { code: 'apply_error' }), ev('release_requested', { kind: 'console' }),
      ev('agent_released', { kind: 'console' }), ev('agent_expired'), ev('agent_self_released'),
      ev('agent_released_locally', { kind: 'local_code' }), ev('agent_absent'), ev('uninstalled'), ev('not_delivered'),
      ev('extend', { expiresAt: EXPIRES }), ev('acknowledge'),
    ];
    for (const e of events) expect(ignored(row, e), `${state} + ${e.type}`).toBe('already_terminal');
  });

  it('a same-generation agent_verified after failed is already_terminal, never a re-open', () => {
    const row = snap({ state: 'failed', failureCode: 'enforcement_not_observed', desiredState: 'released', releaseConfirmedAt: T0 });
    expect(ignored(row, ev('agent_verified', { generation: 1, journalSeq: 99 }))).toBe('already_terminal');
  });

  it('acknowledge is valid only from an unresolved terminal state', () => {
    for (const state of ACTIVE_STATES) {
      expect(ignored(snap({ state }), ev('acknowledge')), state).toBe('invalid_transition');
    }
    for (const state of RESOLVED_TERMINAL_STATES) {
      const row = snap({ state, desiredState: 'released', failureCode: state === 'failed' ? 'apply_error' : null });
      expect(ignored(row, ev('acknowledge')), state).toBe('already_terminal');
    }
  });

  it('an unresolved terminal state accepts nothing but acknowledge', () => {
    for (const state of UNRESOLVED_TERMINAL_STATES) {
      const row = snap({ state, desiredState: 'released', releaseConfirmedAt: T0 });
      for (const e of [ev('agent_verified', { journalSeq: 5 }), ev('release_requested', { kind: 'console' }), ev('extend', { expiresAt: EXPIRES }), ev('agent_absent')]) {
        expect(ignored(row, e), `${state} + ${e.type}`).toBe('already_terminal');
      }
    }
  });

  it.each(ACTIVE_STATES)('release_requested is valid from %s', (state) => {
    expect('next' in applyEpisodeEvent(snap({ state }), ev('release_requested', { kind: 'console' }))).toBe(true);
  });

  it('agent_absent sets release_confirmed_at: on the tombstone and on an unconfirmed resolved episode', () => {
    const tombstone = snap({ state: 'release_requested', desiredState: 'released', generation: 2, releaseKind: 'ai' });
    expect(next(tombstone, ev('agent_absent', { generation: 2, journalSeq: 3 })))
      .toMatchObject({ state: 'released', releaseConfirmedAt: AT, releasedAt: AT, releaseKind: 'ai' });

    const undelivered = snap({ state: 'failed', failureCode: 'not_delivered', desiredState: 'released', generation: 2 });
    expect(next(undelivered, ev('agent_absent', { generation: 2 }))).toEqual({ ...undelivered, releaseConfirmedAt: AT });
    expect(ignored({ ...undelivered, releaseConfirmedAt: T0 }, ev('agent_absent', { generation: 2 }))).toBe('already_terminal');
  });
});

describe('ordering and precedence', () => {
  it('lets agent progress skip states it never reported, but never move backwards', () => {
    expect(next(snap({ state: 'dispatched' }), ev('agent_verified', { journalSeq: 1 }))).toMatchObject({ state: 'verified', appliedAt: AT, verifiedAt: AT });
    expect(next(snap(), ev('agent_applied', { journalSeq: 1 }))).toMatchObject({ state: 'applied' });
    expect(ignored(snap({ state: 'verified' }), ev('agent_applied', { journalSeq: 5 }))).toBe('invalid_transition');
    expect(ignored(snap({ state: 'applied' }), ev('agent_ack', { journalSeq: 5 }))).toBe('invalid_transition');
  });

  it('a late isolate progress report cannot pull a release back', () => {
    const tombstone = snap({ state: 'release_requested', desiredState: 'released', generation: 2 });
    for (const e of [ev('agent_verified', { generation: 2, journalSeq: 5 }), ev('agent_applied', { generation: 2 }), ev('dispatched', { generation: 2 }), ev('extend', { generation: 2, expiresAt: EXPIRES })]) {
      expect(ignored(tombstone, e), e.type).toBe('invalid_transition');
    }
  });

  it('a local or dead-man release while a release is pending resolves the release, not a new unresolved state', () => {
    const tombstone = snap({ state: 'release_requested', desiredState: 'released', generation: 2, releaseKind: 'console' });
    expect(next(tombstone, ev('agent_released_locally', { kind: 'local_code', generation: 2 }))).toMatchObject({ state: 'released', releaseKind: 'console' });
    expect(next(tombstone, ev('agent_self_released', { generation: 2 }))).toMatchObject({ state: 'released', releaseKind: 'console' });
    expect(next(tombstone, ev('agent_expired', { generation: 2 }))).toMatchObject({ state: 'expired', releaseKind: 'expired' });
  });

  it('agent_released or agent_absent while isolation is still desired is invalid (reconcile classifies it as local)', () => {
    for (const state of ISOLATED_ACTIVE) {
      expect(ignored(snap({ state }), ev('agent_released', { kind: 'console' })), state).toBe('invalid_transition');
      expect(ignored(snap({ state }), ev('agent_absent')), state).toBe('invalid_transition');
    }
  });

  it('not_delivered only applies before the agent acted', () => {
    for (const state of ['applying', 'applied', 'verified', 'release_requested'] as const) {
      expect(ignored(snap({ state }), ev('not_delivered')), state).toBe('invalid_transition');
    }
  });

  it('a generation the server never issued is invalid, never adopted', () => {
    expect(ignored(snap({ state: 'verified', generation: 2 }), ev('agent_verified', { generation: 3, journalSeq: 1 }))).toBe('invalid_transition');
  });

  it('accepted events without a journalSeq keep last_journal_seq', () => {
    expect(next(snap({ lastJournalSeq: 12 }), ev('dispatched'))).toMatchObject({ lastJournalSeq: 12 });
  });

  it('never mutates its input', () => {
    const row = Object.freeze(snap({ state: 'verified' }));
    expect(() => applyEpisodeEvent(row, ev('release_requested', { kind: 'console' }))).not.toThrow();
    expect(row.state).toBe('verified');
  });

  it('every reachable next state is a known state, and failed always carries a code', () => {
    const all: EpisodeEvent[] = [
      ev('dispatched'), ev('agent_ack'), ev('agent_applied'), ev('agent_verified'), ev('agent_failed', { code: 'apply_error' }),
      ev('release_requested', { kind: 'console' }), ev('agent_released', { kind: 'console' }), ev('agent_expired'),
      ev('agent_self_released'), ev('agent_released_locally', { kind: 'local_forced' }), ev('agent_absent'), ev('uninstalled'),
      ev('not_delivered'), ev('extend', { expiresAt: EXPIRES }), ev('acknowledge'),
    ];
    for (const state of ISOLATION_STATES) {
      const row = snap({ state: state as IsolationState, failureCode: state === 'failed' ? 'apply_error' : null });
      for (const e of all) {
        const out = applyEpisodeEvent(row, e);
        if ('next' in out) {
          expect(ISOLATION_STATES).toContain(out.next.state);
          expect(out.next.state === 'failed', `${state} + ${e.type}`).toBe(out.next.failureCode !== null);
        }
      }
    }
  });
});

describe('purity', () => {
  it('imports nothing from the DB layer', () => {
    const src = readFileSync(resolve(__dirname, 'stateMachine.ts'), 'utf8');
    const imports = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    expect(imports.filter((p) => /\/db\b|drizzle|postgres/.test(p!))).toEqual([]);
  });
});
