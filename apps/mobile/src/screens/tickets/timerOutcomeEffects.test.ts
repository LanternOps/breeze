import { describe, it, expect, vi } from 'vitest';

// `timeEntries` pulls in `../../services/api`, which imports @sentry/react-native.
vi.mock('../../services/api', () => ({ coreRequest: vi.fn() }));

import {
  startOutcomeEffects,
  stopComposerTicketId,
  stopOutcomeEffects,
} from './timerOutcomeEffects';
import type { TimeEntry } from '../../services/timeEntries';
import type { LocalTimer } from '../../services/localTimer';

const entry: TimeEntry = {
  id: 'e1',
  ticketId: 'k1',
  startedAt: '2026-08-23T10:00:00Z',
  endedAt: null,
  durationMinutes: null,
  isBillable: true,
  billingStatus: 'not_billed',
  isApproved: false,
  description: null,
};

describe('stopOutcomeEffects', () => {
  it('clears the running timer when the stop was queued offline', () => {
    // The technician has stated the timer is over and the queued write is what
    // makes the server agree. Leaving `running` populated keeps the bar ticking
    // past a stop that reported success, and invites a duplicate stop that
    // replays as 404 and is dropped with a false "could not be saved" alarm.
    const effects = stopOutcomeEffects({ ok: 'queued' });

    expect(effects.clearRunning).toBe(true);
    expect(effects.refreshQueueDepth).toBe(true);
    expect(effects.toast).toEqual({
      kind: 'success',
      text: 'Saved offline — it will sync when you reconnect.',
    });
  });

  it('clears the running timer on a successful stop', () => {
    const effects = stopOutcomeEffects({ ok: true, entry });
    expect(effects.clearRunning).toBe(true);
    expect(effects.reload).toBe(true);
  });

  it('clears the running timer when the server says nothing was running', () => {
    const effects = stopOutcomeEffects({
      ok: false,
      reason: 'not-running',
      message: 'No timer is running.',
    });
    expect(effects.clearRunning).toBe(true);
    expect(effects.toast).toEqual({ kind: 'error', text: 'No timer is running.' });
  });

  it('records an account-level denial as sticky', () => {
    const effects = stopOutcomeEffects({
      ok: false,
      reason: 'denied',
      message: 'wall',
      denial: { reason: 'scope', message: 'wall' },
    });
    expect(effects.accountDenial).toEqual({ reason: 'scope', message: 'wall' });
  });

  it('does NOT record a per-entry denial as an account-level wall', () => {
    // A verdict about one row must never withdraw time tracking app-wide: the
    // Stop control disappears from a running timer and the Time tab is replaced
    // until sign-out.
    const effects = stopOutcomeEffects({
      ok: false,
      reason: 'denied',
      message: 'that entry is approved',
      denial: { reason: 'entry', message: 'that entry is approved' },
    });
    expect(effects.accountDenial).toBeNull();
    expect(effects.toast).toEqual({ kind: 'error', text: 'that entry is approved' });
    expect(effects.clearRunning).toBe(false);
  });
});

const timer: LocalTimer = {
  localId: 'l1',
  ticketId: 'k1',
  serverEntryId: null,
  startedAtWall: '2026-08-30T09:00:00.000Z',
  startedAtMono: 0,
  monoEpochId: 'launch-1',
  startConfirmed: true,
  description: null,
};

describe('startOutcomeEffects', () => {
  it('adopts the started entry under its server id', () => {
    const effects = startOutcomeEffects({ ok: true, entry });
    expect(effects.startRunning).toEqual({
      id: 'e1',
      localId: null,
      ticketId: 'k1',
      ticketNumber: null,
      ticketSubject: null,
      startedAt: '2026-08-23T10:00:00Z',
      description: null,
    });
    expect(effects.toast).toEqual({ kind: 'success', text: 'Timer started' });
  });

  it('carries the joined ticket label fields so the bar never shows a placeholder first', () => {
    // TimerBar's label falls back to the literal "Ticket" until `running`
    // carries a resolved ticketNumber/ticketSubject. Dropping these here (as
    // the entry the server returned already has them) meant the bar rendered
    // "Ticket" for one tick, then flipped to "#T-2026-0006" once a later
    // reconciliation pass filled them in.
    const effects = startOutcomeEffects({
      ok: true,
      entry: { ...entry, ticketNumber: 'T-2026-0006', ticketSubject: 'Printer offline' },
    });
    expect(effects.startRunning).toMatchObject({
      ticketNumber: 'T-2026-0006',
      ticketSubject: 'Printer offline',
    });
  });

  it('DOES adopt a local timer, so both surfaces offer Stop offline', () => {
    // The regression this pins: returning null here left `state.time.running`
    // null, so TicketDetailScreen kept rendering "Start timer" and the TimerBar
    // rendered no Stop control at all. A timer started offline could therefore
    // never be stopped offline, and the offline span was lost.
    const effects = startOutcomeEffects({ ok: 'local', timer });
    expect(effects.startRunning).not.toBeNull();
    expect(effects.startRunning).toEqual({
      id: null,
      localId: 'l1',
      ticketId: 'k1',
      startedAt: '2026-08-30T09:00:00.000Z',
      description: null,
    });
  });

  it('parks a stop whose clock ran backwards and clears the bar', () => {
    const effects = stopOutcomeEffects({
      ok: false,
      reason: 'unusable-clock',
      message: 'The device clock changed while this timer ran.',
    });
    expect(effects.clearRunning).toBe(true);
    expect(effects.refreshNeedsAttention).toBe(true);
    expect(effects.toast.kind).toBe('error');
  });

  it('keeps an ownership denial off the account-level wall', () => {
    const effects = startOutcomeEffects({
      ok: false,
      reason: 'denied',
      message: 'someone else owns it',
      denial: { reason: 'ownership', message: 'someone else owns it' },
    });
    expect(effects.accountDenial).toBeNull();
    expect(effects.notice).toBe('someone else owns it');
  });

  it('keeps a role-grant denial ON the account-level wall', () => {
    const effects = startOutcomeEffects({
      ok: false,
      reason: 'denied',
      message: 'ask an admin',
      denial: { reason: 'permission', message: 'ask an admin' },
    });
    expect(effects.accountDenial).toEqual({ reason: 'permission', message: 'ask an admin' });
  });
});

describe('stopComposerTicketId (#5366)', () => {
  const running = {
    id: 'e1',
    localId: null,
    ticketId: 'k1',
    startedAt: '2026-08-23T10:00:00Z',
    description: null,
  };

  it('names the stopped ticket on a completed stop', () => {
    expect(stopComposerTicketId({ ok: true, entry }, running)).toBe('k1');
  });

  it('falls back to the running timer on a queued stop, which carries no entry', () => {
    // The offline path returns `{ ok: 'queued' }` and nothing else, so the only
    // record of WHICH ticket was being timed is the pre-stop running timer.
    expect(stopComposerTicketId({ ok: 'queued' }, running)).toBe('k1');
  });

  it('prefers the entry ticket over the running timer when they disagree', () => {
    // The server is authoritative about what it just closed.
    expect(stopComposerTicketId({ ok: true, entry: { ...entry, ticketId: 'k2' } }, running)).toBe(
      'k2'
    );
  });

  it('opens nothing when the stop recorded no span', () => {
    // A denied, unknown, not-running or unusable-clock stop has nothing to
    // annotate, and yanking the technician to a composer would bury the error
    // notice they need to read.
    for (const reason of ['denied', 'unknown', 'not-running', 'unusable-clock'] as const) {
      expect(stopComposerTicketId({ ok: false, reason, message: 'nope' }, running)).toBeNull();
    }
  });

  it('opens nothing for general time, which has no ticket', () => {
    expect(stopComposerTicketId({ ok: 'queued' }, { ...running, ticketId: null })).toBeNull();
    expect(stopComposerTicketId({ ok: true, entry: { ...entry, ticketId: null } }, null)).toBeNull();
  });
});
