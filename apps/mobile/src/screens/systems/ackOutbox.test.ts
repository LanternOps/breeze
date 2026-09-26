import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => {
  const map = new Map<string, string>();
  return {
    map,
    failWrites: false,
    getItem: vi.fn(async (key: string) => map.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      if (storage.failWrites) throw new Error('disk full');
      map.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      map.delete(key);
    }),
  };
});

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: storage.getItem,
    setItem: storage.setItem,
    removeItem: storage.removeItem,
  },
}));

import {
  ACK_OUTBOX_KEY,
  ACK_OUTBOX_TTL_MS,
  addEntries,
  clearAcks,
  isPermanentAckError,
  parseOutbox,
  planReplay,
  readOutbox,
  recordHeldAcks,
  removeEntries,
  sendAcknowledge,
  settledIds,
  takeReplay,
  type AckOutcome,
} from './ackOutbox';

const T0 = 1_800_000_000_000;

function outcome(partial: Partial<AckOutcome>): AckOutcome {
  return { acknowledged: [], failed: [], unknown: [], errors: [], ...partial };
}

beforeEach(() => {
  storage.map.clear();
  storage.failWrites = false;
  storage.getItem.mockClear();
  storage.setItem.mockClear();
});

describe('parseOutbox', () => {
  it('returns [] for missing, unparseable, or non-array blobs', () => {
    expect(parseOutbox(null)).toEqual([]);
    expect(parseOutbox('{not json')).toEqual([]);
    expect(parseOutbox('{"a":1}')).toEqual([]);
  });

  it('drops malformed rows but keeps well-formed ones', () => {
    const raw = JSON.stringify([
      { alertId: 'a', owner: 'u1', queuedAt: T0 },
      { alertId: 7, owner: 'u1', queuedAt: T0 },
      { alertId: 'b', owner: null, queuedAt: T0 },
      { alertId: 'c', owner: 'u1', queuedAt: 'yesterday' },
    ]);
    expect(parseOutbox(raw)).toEqual([{ alertId: 'a', owner: 'u1', queuedAt: T0 }]);
  });
});

describe('addEntries / removeEntries', () => {
  it('adds one entry per id and refreshes a re-acknowledged id instead of duplicating it', () => {
    const first = addEntries([], ['a', 'b'], 'u1', T0);
    const second = addEntries(first, ['b', 'c'], 'u1', T0 + 10);
    expect(second).toEqual([
      { alertId: 'a', owner: 'u1', queuedAt: T0 },
      { alertId: 'b', owner: 'u1', queuedAt: T0 + 10 },
      { alertId: 'c', owner: 'u1', queuedAt: T0 + 10 },
    ]);
  });

  it('removes only the named ids', () => {
    const entries = addEntries([], ['a', 'b', 'c'], 'u1', T0);
    expect(removeEntries(entries, ['b']).map((e) => e.alertId)).toEqual(['a', 'c']);
  });
});

describe('planReplay', () => {
  const entries = [
    { alertId: 'fresh', owner: 'u1', queuedAt: T0 },
    { alertId: 'stale', owner: 'u1', queuedAt: T0 - ACK_OUTBOX_TTL_MS - 1 },
    { alertId: 'other-user', owner: 'u2', queuedAt: T0 },
    { alertId: 'other-user-stale', owner: 'u2', queuedAt: T0 - ACK_OUTBOX_TTL_MS - 1 },
  ];

  it('replays only the current owner’s unexpired ids', () => {
    const plan = planReplay(entries, 'u1', T0 + 1000);
    expect(plan.replay).toEqual(['fresh']);
  });

  it('expires stale ids of every owner and keeps a different account’s fresh ids untouched', () => {
    const plan = planReplay(entries, 'u1', T0 + 1000);
    expect(plan.expired).toEqual(['stale']);
    // Replayed ids STAY until the server confirms them; another account's
    // unexpired ids are never sent under this account's credentials, but are
    // kept for that account's return.
    expect(plan.keep.map((e) => e.alertId)).toEqual(['fresh', 'other-user']);
  });

  it('replays nothing when no user is known', () => {
    const plan = planReplay(entries, null, T0 + 1000);
    expect(plan.replay).toEqual([]);
  });
});

describe('isPermanentAckError / settledIds', () => {
  it('treats client-error statuses as permanent, but not auth, timeout, or rate limit', () => {
    expect(isPermanentAckError({ statusCode: 404 })).toBe(true);
    expect(isPermanentAckError({ statusCode: 403 })).toBe(true);
    expect(isPermanentAckError({ statusCode: 400 })).toBe(true);
    expect(isPermanentAckError({ statusCode: 401 })).toBe(false);
    expect(isPermanentAckError({ statusCode: 408 })).toBe(false);
    expect(isPermanentAckError({ statusCode: 429 })).toBe(false);
    expect(isPermanentAckError({ statusCode: 503 })).toBe(false);
    expect(isPermanentAckError(new Error('Network request failed'))).toBe(false);
  });

  it('settles confirmed and refused ids but keeps transport-unknown ones for retry', () => {
    const o = outcome({
      acknowledged: ['a'],
      failed: ['b'],
      unknown: ['c'],
      errors: [new Error('timeout')],
    });
    expect(settledIds(o)).toEqual(['a', 'b']);
  });

  it('settles unknown ids when the request was refused outright (e.g. 404 no accessible alerts)', () => {
    const o = outcome({ unknown: ['a', 'b'], errors: [{ statusCode: 404 }] });
    expect(settledIds(o)).toEqual(['a', 'b']);
  });
});

describe('persisted outbox', () => {
  it('survives a "restart": held ids are readable from storage alone', async () => {
    await recordHeldAcks(['a', 'b'], 'u1', T0);
    expect(parseOutbox(storage.map.get(ACK_OUTBOX_KEY) ?? null).map((e) => e.alertId)).toEqual([
      'a',
      'b',
    ]);
    expect((await readOutbox()).length).toBe(2);
  });

  it('serialises concurrent mutations so none is lost', async () => {
    await Promise.all([
      recordHeldAcks(['a'], 'u1', T0),
      recordHeldAcks(['b'], 'u1', T0),
      clearAcks(['a']),
      recordHeldAcks(['c'], 'u1', T0),
    ]);
    expect((await readOutbox()).map((e) => e.alertId)).toEqual(['b', 'c']);
  });

  it('takeReplay prunes expired ids from storage and returns what to send', async () => {
    await recordHeldAcks(['old'], 'u1', T0 - ACK_OUTBOX_TTL_MS - 1);
    await recordHeldAcks(['new'], 'u1', T0);
    const plan = await takeReplay('u1', T0 + 1);
    expect(plan).toEqual({ replay: ['new'], expired: ['old'] });
    expect((await readOutbox()).map((e) => e.alertId)).toEqual(['new']);
  });

  it('reports storage failure instead of throwing', async () => {
    storage.failWrites = true;
    await expect(recordHeldAcks(['a'], 'u1', T0)).resolves.toBe(false);
  });
});

describe('sendAcknowledge', () => {
  it('keeps the batch in the outbox until the server answers, then clears settled ids', async () => {
    await recordHeldAcks(['a', 'b', 'c'], 'u1', T0);
    let seenDuringFlight: string[] = [];
    const send = vi.fn(async (ids: string[]) => {
      // The request is in flight: nothing has been cleared yet, so a process
      // kill here leaves the whole batch recoverable.
      seenDuringFlight = (await readOutbox()).map((e) => e.alertId);
      return outcome({ acknowledged: ['a'], failed: ['b'], unknown: ['c'], errors: [new Error('t')] });
    });
    const result = await sendAcknowledge(send, ['a', 'b', 'c']);
    expect(send).toHaveBeenCalledWith(['a', 'b', 'c']);
    expect(seenDuringFlight).toEqual(['a', 'b', 'c']);
    expect(result.unknown).toEqual(['c']);
    expect((await readOutbox()).map((e) => e.alertId)).toEqual(['c']);
  });

  it('keeps every id when the transport rejects outright', async () => {
    await recordHeldAcks(['a', 'b'], 'u1', T0);
    const send = vi.fn(async () => {
      throw new Error('boom');
    });
    const result = await sendAcknowledge(send, ['a', 'b']);
    expect(result.unknown).toEqual(['a', 'b']);
    expect((await readOutbox()).map((e) => e.alertId)).toEqual(['a', 'b']);
  });
});
