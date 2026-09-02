import { describe, it, expect, vi } from 'vitest';

// `timeEntries` pulls in `../../services/api`, which imports @sentry/react-native
// — Flow syntax Vitest's node environment cannot parse.
vi.mock('./api', () => ({ coreRequest: vi.fn() }));
// `timeEntryQueue` (for QUEUED_KINDS) imports @sentry/react-native, a Flow
// source this .ts-only suite cannot parse.
vi.mock('@sentry/react-native', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

import { makeReplaySender, UnreplayableWriteError, type ReplaySenders } from './timeEntryReplay';
import { QUEUED_KINDS, type QueuedWrite } from './timeEntryQueue';

const SERVER_NOW = Date.parse('2026-08-30T18:00:00.000Z');

function write(overrides: Partial<QueuedWrite> & Pick<QueuedWrite, 'kind'>): QueuedWrite {
  return {
    id: 'w1',
    payload: {},
    queuedAt: '2026-08-30T09:00:00.000Z',
    attempts: 0,
    ...overrides,
  };
}

function senders() {
  return {
    createTimeEntry: vi.fn().mockResolvedValue({ id: 'e1' }),
    updateTimeEntry: vi.fn().mockResolvedValue({ id: 'e1' }),
    confirmSuggestion: vi.fn().mockResolvedValue({ entry: { id: 'e1' }, replay: false }),
    dismissSuggestion: vi.fn().mockResolvedValue(undefined),
    serverNow: () => SERVER_NOW,
  };
}

// A compile-time guard, not a runtime one: reintroducing either verb to
// `ReplaySenders` makes this line a type error, which is the whole point of
// removing them from the interface rather than merely not calling them.
type TimerVerbsOnSenders = Extract<keyof ReplaySenders, 'startTimer' | 'stopTimer'>;
const NO_TIMER_VERBS: TimerVerbsOnSenders extends never ? true : false = true;

describe('the replay can never call a server-stamped timer verb', () => {
  it('does not declare startTimer or stopTimer on ReplaySenders', () => {
    expect(NO_TIMER_VERBS).toBe(true);
  });

  it('touches no sender other than the two timestamped endpoints, for EVERY queued kind', async () => {
    // A Proxy records every property the sender reaches for, so this fails if a
    // future edit calls `senders.startTimer?.()` defensively rather than only
    // if the interface changes.
    const touched = new Set<string>();
    const startTimer = vi.fn();
    const stopTimer = vi.fn();
    const backing: Record<string, unknown> = {
      createTimeEntry: vi.fn().mockResolvedValue({ id: 'e1' }),
      updateTimeEntry: vi.fn().mockResolvedValue({ id: 'e1' }),
      confirmSuggestion: vi.fn().mockResolvedValue({ entry: { id: 'e1' }, replay: false }),
      dismissSuggestion: vi.fn().mockResolvedValue(undefined),
      serverNow: () => SERVER_NOW,
      startTimer,
      stopTimer,
    };
    const recorder = new Proxy(backing, {
      get(target, key) {
        if (typeof key !== 'string') return undefined;
        touched.add(key);
        return target[key];
      },
    }) as unknown as ReplaySenders;

    const send = makeReplaySender(recorder);
    for (const kind of QUEUED_KINDS) {
      await send(
        write({
          kind,
          payload: {
            id: 'E',
            startedAt: '2026-08-30T09:00:00.000Z',
            endedAt: '2026-08-30T09:40:00.000Z',
            // W06 kinds need signals; the other kinds ignore the key.
            signals: [{ kind: 'remote_session', id: 'aaaa1111-0000-4000-8000-000000000001' }],
          },
        })
      );
    }

    expect(startTimer).toHaveBeenCalledTimes(0);
    expect(stopTimer).toHaveBeenCalledTimes(0);
    expect([...touched].sort()).toEqual([
      'confirmSuggestion', 'createTimeEntry', 'dismissSuggestion', 'serverNow', 'updateTimeEntry',
    ]);
  });
});

describe('makeReplaySender', () => {
  it('posts a create with the stored bounds when they are already in the past', async () => {
    const deps = senders();
    await makeReplaySender(deps)(
      write({
        kind: 'create',
        payload: {
          startedAt: '2026-08-30T09:00:00.000Z',
          endedAt: '2026-08-30T09:40:00.000Z',
          ticketId: 'k1',
          description: 'basement switch',
          isBillable: true,
        },
      })
    );
    expect(deps.createTimeEntry).toHaveBeenCalledWith({
      startedAt: '2026-08-30T09:00:00.000Z',
      endedAt: '2026-08-30T09:40:00.000Z',
      ticketId: 'k1',
      description: 'basement switch',
      isBillable: true,
    });
  });

  it('shifts a future-dated span into the past and persists the shift on the write', async () => {
    // The phone is 3h fast. Unshifted this is a permanent 400 (notFarFuture),
    // and the drain would park the technician's real work for manual re-entry.
    const deps = senders();
    const queued = write({
      kind: 'create',
      payload: { startedAt: '2026-08-30T20:20:00.000Z', endedAt: '2026-08-30T21:00:00.000Z' },
    });
    await makeReplaySender(deps)(queued);

    const sent = deps.createTimeEntry.mock.calls[0][0] as { startedAt: string; endedAt: string };
    expect(Date.parse(sent.startedAt)).toBeLessThanOrEqual(SERVER_NOW);
    expect(Date.parse(sent.endedAt) - Date.parse(sent.startedAt)).toBe(40 * 60_000);
    // The rewrite has to reach storage, or a retry shifts an already-shifted
    // span a second time.
    expect(queued.payload).toMatchObject({ startedAt: sent.startedAt, endedAt: sent.endedAt });
  });

  it('closes a server-started entry by id at its true tap time', async () => {
    const deps = senders();
    await makeReplaySender(deps)(
      write({
        kind: 'closeEntry',
        payload: { id: 'E', endedAt: '2026-08-30T15:00:00.000Z', isBillable: false },
      })
    );
    // NOT the 18:00 replay time: `/time-entries/stop` would have stamped that.
    expect(deps.updateTimeEntry).toHaveBeenCalledWith('E', {
      endedAt: '2026-08-30T15:00:00.000Z',
      isBillable: false,
    });
  });

  it('does not shift a closeEntry — the row it closes carries the server\'s own startedAt', async () => {
    const deps = senders();
    await makeReplaySender(deps)(
      write({ kind: 'closeEntry', payload: { id: 'E', endedAt: '2026-08-30T21:00:00.000Z' } })
    );
    expect(deps.updateTimeEntry).toHaveBeenCalledWith('E', { endedAt: '2026-08-30T21:00:00.000Z' });
  });

  it('propagates the server error untouched so drain can read its status', async () => {
    const deps = senders();
    const error = Object.assign(new Error('nope'), { status: 409 });
    deps.createTimeEntry.mockRejectedValue(error);
    await expect(
      makeReplaySender(deps)(
        write({
          kind: 'create',
          payload: { startedAt: '2026-08-30T09:00:00.000Z', endedAt: '2026-08-30T09:40:00.000Z' },
        })
      )
    ).rejects.toBe(error);
  });

  it('rejects an unknown kind as a permanent 400 rather than wedging the queue', async () => {
    const failure = await makeReplaySender(senders())(
      write({ kind: 'somethingNew' as QueuedWrite['kind'] })
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(UnreplayableWriteError);
    expect((failure as UnreplayableWriteError).status).toBe(400);
  });

  it('rejects a create missing its time bounds as a permanent 400', async () => {
    await expect(
      makeReplaySender(senders())(write({ kind: 'create', payload: { ticketId: 'k1' } }))
    ).rejects.toBeInstanceOf(UnreplayableWriteError);
  });

  it('rejects a closeEntry missing its entry id as a permanent 400', async () => {
    await expect(
      makeReplaySender(senders())(
        write({ kind: 'closeEntry', payload: { endedAt: '2026-08-30T15:00:00.000Z' } })
      )
    ).rejects.toBeInstanceOf(UnreplayableWriteError);
  });
});


// ── W06 (#3900): suggestion replay ─────────────────────────────────────────
describe('makeReplaySender — suggestion writes', () => {
  const SIG = { kind: 'remote_session', id: 'aaaa1111-0000-4000-8000-000000000001' };

  function suggestionSenders() {
    return {
      createTimeEntry: vi.fn().mockResolvedValue({ id: 'e1' }),
      updateTimeEntry: vi.fn().mockResolvedValue({ id: 'e1' }),
      confirmSuggestion: vi.fn().mockResolvedValue({ entry: { id: 'e1' }, replay: false }),
      dismissSuggestion: vi.fn().mockResolvedValue(undefined),
      serverNow: () => SERVER_NOW,
    };
  }

  it('replays a confirm with the SERVER session bounds, never shifted', async () => {
    // The decisive case: `create` shifts a future-dated span into the past to
    // survive the server's notFarFuture refine. A confirm must NOT — these
    // bounds describe remote_session rows the server itself recorded, so
    // shifting them would bill a window that never happened.
    const deps = suggestionSenders();
    const future = new Date(SERVER_NOW + 60 * 60 * 1000).toISOString();
    const futureEnd = new Date(SERVER_NOW + 90 * 60 * 1000).toISOString();
    await makeReplaySender(deps)(
      write({ kind: 'suggestion.confirm', payload: { signals: [SIG], startedAt: future, endedAt: futureEnd, ticketId: 'k1' } })
    );
    expect(deps.confirmSuggestion).toHaveBeenCalledWith({
      signals: [SIG], startedAt: future, endedAt: futureEnd, ticketId: 'k1',
    });
  });

  it('drops undefined optional keys rather than sending them as null', async () => {
    const deps = suggestionSenders();
    await makeReplaySender(deps)(
      write({ kind: 'suggestion.confirm', payload: { signals: [SIG], startedAt: '2026-08-30T09:00:00.000Z' } })
    );
    const [input] = deps.confirmSuggestion.mock.calls[0]!;
    expect(input).toEqual({ signals: [SIG], startedAt: '2026-08-30T09:00:00.000Z' });
  });

  it('replays a dismiss with only its signals', async () => {
    const deps = suggestionSenders();
    await makeReplaySender(deps)(write({ kind: 'suggestion.dismiss', payload: { signals: [SIG] } }));
    expect(deps.dismissSuggestion).toHaveBeenCalledWith([SIG]);
  });

  it('parks a confirm with no signals rather than retrying it forever', async () => {
    const deps = suggestionSenders();
    await expect(
      makeReplaySender(deps)(write({ kind: 'suggestion.confirm', payload: { startedAt: '2026-08-30T09:00:00.000Z' } }))
    ).rejects.toMatchObject({ name: 'UnreplayableWriteError', status: 400 });
  });

  it('parks a confirm whose signals survived storage in a malformed shape', async () => {
    const deps = suggestionSenders();
    for (const signals of [[], [{ kind: 'support_session', id: 'x' }], [{ kind: 'remote_session' }], ['nope']]) {
      await expect(
        makeReplaySender(deps)(write({ kind: 'suggestion.confirm', payload: { signals, startedAt: '2026-08-30T09:00:00.000Z' } }))
      ).rejects.toMatchObject({ status: 400 });
    }
    expect(deps.confirmSuggestion).not.toHaveBeenCalled();
  });

  it('strips extra signal fields — the server schema is .strict()', async () => {
    const deps = suggestionSenders();
    await makeReplaySender(deps)(
      write({
        kind: 'suggestion.dismiss',
        payload: { signals: [{ ...SIG, type: 'terminal', precision: 'exact', startedAt: 'x' }] },
      })
    );
    expect(deps.dismissSuggestion).toHaveBeenCalledWith([SIG]);
  });
});
