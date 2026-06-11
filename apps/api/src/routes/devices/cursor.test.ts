import { describe, it, expect } from 'vitest';
import {
  DEVICES_LIST_HARD_MAX,
  DEVICES_LIST_DEFAULT_LIMIT,
  DEVICES_SORT_KEYS,
  cursorFromRow,
  decodeCursor,
  defaultSortDir,
  defaultSortKey,
  encodeCursor,
  type DevicesCursor,
} from './cursor';

describe('cursor constants', () => {
  it('hard max is 1000 (Discussion #742 PR 3 design decision)', () => {
    expect(DEVICES_LIST_HARD_MAX).toBe(1000);
  });

  it('default limit is below the hard max', () => {
    expect(DEVICES_LIST_DEFAULT_LIMIT).toBeLessThan(DEVICES_LIST_HARD_MAX);
    expect(DEVICES_LIST_DEFAULT_LIMIT).toBeGreaterThan(0);
  });

  it('default limit is 500 — matches the pre-#777 unbounded-default contract for no-param callers', () => {
    // Lowering this to a smaller number visibly drops the no-param
    // devices-list from 500 to that number for any caller that lands
    // before #778's cursor walker ships. Keep at 500 until #778 is live;
    // then #778 can lower the default.
    expect(DEVICES_LIST_DEFAULT_LIMIT).toBe(500);
  });

  it('sort whitelist is the three keys backed by covering indexes', () => {
    expect(DEVICES_SORT_KEYS).toEqual(['hostname', 'lastSeen', 'enrolled']);
  });
});

describe('defaultSortDir', () => {
  it('hostname defaults to asc (alphabetical natural)', () => {
    expect(defaultSortDir('hostname')).toBe('asc');
  });
  it('lastSeen defaults to desc (most-recent first)', () => {
    expect(defaultSortDir('lastSeen')).toBe('desc');
  });
  it('enrolled defaults to desc (newest first)', () => {
    expect(defaultSortDir('enrolled')).toBe('desc');
  });
});

describe('defaultSortKey — pagination-mode-aware default sort', () => {
  it('cursor mode defaults to `hostname` (keyset stable on NOT NULL string)', () => {
    expect(defaultSortKey(true)).toBe('hostname');
  });

  it('offset mode defaults to `lastSeen` — preserves the pre-#777 contract for legacy `?page=N` callers', () => {
    // Regression guard: a future "cleanup" that drops this mode branching
    // would silently change every legacy `?page=N` caller's ordering from
    // last_seen_at DESC → hostname ASC, breaking mobile, external API
    // consumers, and the web during the deploy window before #778 ships.
    expect(defaultSortKey(false)).toBe('lastSeen');
  });
});

describe('encodeCursor / decodeCursor roundtrip', () => {
  const cases: DevicesCursor[] = [
    { v: 1, sort: 'hostname', sortDir: 'asc', k: 'fleming-laptop-01', id: '11111111-1111-4111-8111-111111111111' },
    { v: 1, sort: 'hostname', sortDir: 'desc', k: '', id: '22222222-2222-4222-8222-222222222222' },
    { v: 1, sort: 'lastSeen', sortDir: 'desc', k: '2026-05-19T01:14:24.000Z', id: '33333333-3333-4333-8333-333333333333' },
    { v: 1, sort: 'lastSeen', sortDir: 'desc', k: null, id: '44444444-4444-4444-8444-444444444444' }, // NULL phase
    { v: 1, sort: 'enrolled', sortDir: 'asc', k: '2024-01-01T00:00:00.000Z', id: '55555555-5555-4555-8555-555555555555' },
  ];

  for (const c of cases) {
    it(`roundtrips ${c.sort}/${c.sortDir} (k=${String(c.k)})`, () => {
      const token = encodeCursor(c);
      // base64url has no '+', '/', or '=' chars
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
      const decoded = decodeCursor(token);
      expect(decoded).toEqual(c);
    });
  }
});

describe('decodeCursor — null/empty/garbage rejections', () => {
  it('returns null for undefined', () => {
    expect(decodeCursor(undefined)).toBeNull();
  });
  it('returns null for empty string', () => {
    expect(decodeCursor('')).toBeNull();
  });
  it('returns null for null', () => {
    expect(decodeCursor(null)).toBeNull();
  });
  it('returns null for non-base64url chars', () => {
    expect(decodeCursor('not a valid token!!!')).toBeNull();
  });
  it('returns null for non-JSON base64', () => {
    const garbage = Buffer.from('not json at all').toString('base64url');
    expect(decodeCursor(garbage)).toBeNull();
  });
  it('returns null for wrong-version cursor (forward compat)', () => {
    const bad = Buffer.from(JSON.stringify({ v: 99, sort: 'hostname', sortDir: 'asc', k: 'x', id: 'x' })).toString('base64url');
    expect(decodeCursor(bad)).toBeNull();
  });
  it('returns null for unknown sort key', () => {
    const bad = Buffer.from(JSON.stringify({ v: 1, sort: 'thisIsNotASort', sortDir: 'asc', k: 'x', id: 'x' })).toString('base64url');
    expect(decodeCursor(bad)).toBeNull();
  });
  it('returns null for bogus sortDir', () => {
    const bad = Buffer.from(JSON.stringify({ v: 1, sort: 'hostname', sortDir: 'sideways', k: 'x', id: 'x' })).toString('base64url');
    expect(decodeCursor(bad)).toBeNull();
  });
  it('returns null when id is missing', () => {
    const bad = Buffer.from(JSON.stringify({ v: 1, sort: 'hostname', sortDir: 'asc', k: 'x' })).toString('base64url');
    expect(decodeCursor(bad)).toBeNull();
  });
  it('returns null when k is wrong type (object)', () => {
    const bad = Buffer.from(JSON.stringify({ v: 1, sort: 'hostname', sortDir: 'asc', k: { not: 'a string' }, id: 'x' })).toString('base64url');
    expect(decodeCursor(bad)).toBeNull();
  });
});

describe('cursorFromRow', () => {
  const baseRow = {
    id: '99999999-9999-4999-8999-999999999999',
    hostname: 'srv-edge-01',
    lastSeenAt: new Date('2026-05-18T22:33:11.000Z'),
    enrolledAt: new Date('2025-08-16T16:52:42.000Z'),
  };

  it('hostname cursor carries hostname as k', () => {
    expect(cursorFromRow(baseRow, 'hostname', 'asc')).toEqual({
      v: 1,
      sort: 'hostname',
      sortDir: 'asc',
      k: 'srv-edge-01',
      id: baseRow.id,
    });
  });

  it('lastSeen cursor carries ISO timestamp as k', () => {
    expect(cursorFromRow(baseRow, 'lastSeen', 'desc')).toEqual({
      v: 1,
      sort: 'lastSeen',
      sortDir: 'desc',
      k: '2026-05-18T22:33:11.000Z',
      id: baseRow.id,
    });
  });

  it('lastSeen cursor encodes null when row has never checked in', () => {
    const neverSeen = { ...baseRow, lastSeenAt: null };
    expect(cursorFromRow(neverSeen, 'lastSeen', 'desc')).toEqual({
      v: 1,
      sort: 'lastSeen',
      sortDir: 'desc',
      k: null,
      id: baseRow.id,
    });
  });

  it('enrolled cursor carries ISO timestamp as k', () => {
    expect(cursorFromRow(baseRow, 'enrolled', 'desc')).toEqual({
      v: 1,
      sort: 'enrolled',
      sortDir: 'desc',
      k: '2025-08-16T16:52:42.000Z',
      id: baseRow.id,
    });
  });
});
