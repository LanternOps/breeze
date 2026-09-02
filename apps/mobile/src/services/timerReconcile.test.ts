import { describe, it, expect, vi } from 'vitest';

vi.mock('./api', () => ({ coreRequest: vi.fn() }));
vi.mock('@sentry/react-native', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

import {
  findDeliveredDuplicate,
  matchesServerTimer,
  needsReconciliation,
  planReconciliation,
} from './timerReconcile';
import type { LocalTimer } from './localTimer';
import type { RunningTimer, TimeEntry } from './timeEntries';
import type { QueuedWrite } from './timeEntryQueue';

const server: RunningTimer = {
  id: 'E',
  localId: null,
  ticketId: 'k1',
  startedAt: '2026-08-30T09:00:04.000Z',
  description: null,
};

function local(overrides: Partial<LocalTimer> = {}): LocalTimer {
  return {
    localId: 'l1',
    ticketId: 'k1',
    serverEntryId: null,
    startedAtWall: '2026-08-30T09:00:00.000Z',
    startedAtMono: 0,
    monoEpochId: 'launch-1',
    startConfirmed: false,
    description: null,
    ...overrides,
  };
}

function createWrite(overrides: Partial<QueuedWrite> = {}): QueuedWrite {
  return {
    id: 'w1',
    kind: 'create',
    payload: {
      ticketId: 'k1',
      startedAt: '2026-08-30T09:00:00.000Z',
      endedAt: '2026-08-30T09:40:00.000Z',
      unconfirmedStart: true,
    },
    queuedAt: '2026-08-30T09:40:00.000Z',
    attempts: 0,
    ...overrides,
  };
}

describe('matchesServerTimer', () => {
  it('matches on ticket and a start within ten minutes', () => {
    expect(matchesServerTimer({ ticketId: 'k1', startedAtMs: Date.parse('2026-08-30T09:00:00Z') }, server)).toBe(true);
  });

  it('rejects a different ticket even at the same instant', () => {
    expect(matchesServerTimer({ ticketId: 'k2', startedAtMs: Date.parse(server.startedAt) }, server)).toBe(false);
  });

  it('rejects a start outside the window — that is somebody else\'s timer', () => {
    expect(matchesServerTimer({ ticketId: 'k1', startedAtMs: Date.parse('2026-08-30T08:30:00Z') }, server)).toBe(false);
  });
});

describe('needsReconciliation', () => {
  it('is true for a local timer whose start was never confirmed', () => {
    expect(needsReconciliation(local(), [])).toBe(true);
  });

  it('is false for a confirmed local timer with nothing unconfirmed queued', () => {
    expect(needsReconciliation(local({ startConfirmed: true }), [createWrite({ payload: {} })])).toBe(false);
  });

  it('is true for a queued create carrying unconfirmedStart', () => {
    expect(needsReconciliation(null, [createWrite()])).toBe(true);
  });
});

describe('planReconciliation', () => {
  it('adopts the server identity for a local timer whose start actually landed', () => {
    expect(planReconciliation({ localTimer: local(), queue: [], server })).toEqual({
      adopt: { serverEntryId: 'E', startedAt: '2026-08-30T09:00:04.000Z' },
      substitute: null,
    });
  });

  it('closes the phantom instead of creating a second entry', () => {
    // The start DID land; the create would double-bill the job and leave the
    // server entry running forever.
    expect(planReconciliation({ localTimer: null, queue: [createWrite()], server })).toEqual({
      adopt: null,
      substitute: {
        writeId: 'w1',
        entryId: 'E',
        endedAt: '2026-08-30T09:40:00.000Z',
      },
    });
  });

  it('carries the queued description and billable flag onto the close', () => {
    const write = createWrite({
      payload: {
        ticketId: 'k1',
        startedAt: '2026-08-30T09:00:00.000Z',
        endedAt: '2026-08-30T09:40:00.000Z',
        unconfirmedStart: true,
        description: 'basement switch',
        isBillable: false,
      },
    });
    expect(planReconciliation({ localTimer: null, queue: [write], server }).substitute).toMatchObject({
      description: 'basement switch',
      isBillable: false,
    });
  });

  it('leaves a non-matching server timer alone and sends the create unchanged', () => {
    const other: RunningTimer = { ...server, ticketId: 'k9' };
    expect(planReconciliation({ localTimer: null, queue: [createWrite()], server: other })).toEqual({
      adopt: null,
      substitute: null,
    });
  });

  it('ignores a queued create that is NOT flagged unconfirmed', () => {
    const write = createWrite({
      payload: {
        ticketId: 'k1',
        startedAt: '2026-08-30T09:00:00.000Z',
        endedAt: '2026-08-30T09:40:00.000Z',
      },
    });
    expect(planReconciliation({ localTimer: null, queue: [write], server }).substitute).toBeNull();
  });

  it('plans nothing when no timer is running on the server', () => {
    expect(planReconciliation({ localTimer: local(), queue: [createWrite()], server: null })).toEqual({
      adopt: null,
      substitute: null,
    });
  });
});

describe('findDeliveredDuplicate', () => {
  const entry = (overrides: Partial<TimeEntry> = {}): TimeEntry => ({
    id: 'e1',
    ticketId: 'k1',
    startedAt: '2026-08-30T09:00:00.000Z',
    endedAt: '2026-08-30T09:40:00.000Z',
    durationMinutes: 40,
    isBillable: true,
    billingStatus: 'not_billed',
    isApproved: false,
    description: null,
    ...overrides,
  });

  const candidate = {
    ticketId: 'k1',
    startedAt: '2026-08-30T09:00:30.000Z',
    endedAt: '2026-08-30T09:40:20.000Z',
  };

  it('recognises an entry the lost response already created', () => {
    expect(findDeliveredDuplicate([entry()], candidate)?.id).toBe('e1');
  });

  it('does not treat a different ticket as the same work', () => {
    expect(findDeliveredDuplicate([entry({ ticketId: 'k2' })], candidate)).toBeNull();
  });

  it('does not treat a neighbouring job on the same ticket as a duplicate', () => {
    expect(
      findDeliveredDuplicate(
        [entry({ startedAt: '2026-08-30T11:00:00.000Z', endedAt: '2026-08-30T11:40:00.000Z' })],
        candidate
      )
    ).toBeNull();
  });

  it('ignores a still-running entry, which has no end to compare', () => {
    expect(findDeliveredDuplicate([entry({ endedAt: null })], candidate)).toBeNull();
  });
});
