import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COLUMN_IDS,
  COLUMN_STORAGE_KEY,
  DEFAULT_VISIBLE_COLUMNS,
  isValidColumnId,
  readColumnOrder,
  readColumnVisibility,
  writeColumnOrder,
  writeColumnVisibility,
} from './columnVisibility';

function makeMemoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear() {
      data.clear();
    },
    getItem(key: string) {
      return data.has(key) ? (data.get(key) as string) : null;
    },
    setItem(key: string, value: string) {
      data.set(key, String(value));
    },
    removeItem(key: string) {
      data.delete(key);
    },
    key(i: number) {
      return Array.from(data.keys())[i] ?? null;
    },
  };
}

function stored() {
  return JSON.parse(window.localStorage.getItem(COLUMN_STORAGE_KEY) as string);
}

describe('columnVisibility', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'localStorage', {
      value: makeMemoryStorage(),
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('isValidColumnId', () => {
    it('accepts every entry in COLUMN_IDS', () => {
      for (const id of COLUMN_IDS) {
        expect(isValidColumnId(id)).toBe(true);
      }
    });

    it('rejects strings outside the allowed set', () => {
      expect(isValidColumnId('not-a-column')).toBe(false);
      expect(isValidColumnId('')).toBe(false);
      expect(isValidColumnId('Hostname')).toBe(false);
    });
  });

  describe('readColumnVisibility', () => {
    it('returns the default set when no entry is stored', () => {
      const got = readColumnVisibility();
      for (const id of DEFAULT_VISIBLE_COLUMNS) {
        expect(got.has(id)).toBe(true);
      }
      expect(got.size).toBe(DEFAULT_VISIBLE_COLUMNS.length);
    });

    it('returns the stored visible flags', () => {
      writeColumnVisibility(['hostname', 'status', 'agentVersion']);
      const got = readColumnVisibility();
      expect(got.has('hostname')).toBe(true);
      expect(got.has('agentVersion')).toBe(true);
      expect(got.has('cpu')).toBe(false);
      expect(got.size).toBe(3);
    });

    it('falls back to defaults when JSON is malformed', () => {
      window.localStorage.setItem(COLUMN_STORAGE_KEY, '{not valid json');
      expect(readColumnVisibility().size).toBe(DEFAULT_VISIBLE_COLUMNS.length);
    });

    it('falls back to defaults when the shape has no columns array', () => {
      window.localStorage.setItem(COLUMN_STORAGE_KEY, JSON.stringify({ v: 1 }));
      expect(readColumnVisibility().size).toBe(DEFAULT_VISIBLE_COLUMNS.length);
    });

    it('falls back to the default set when every column is hidden', () => {
      // An all-hidden list is a valid stored state, but an empty table is
      // worse UX than the pre-feature view, so the visible view recovers.
      writeColumnVisibility([]);
      const got = readColumnVisibility();
      expect(got.size).toBe(DEFAULT_VISIBLE_COLUMNS.length);
    });

    it('falls back when getItem throws (Safari private mode)', () => {
      vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
        throw new DOMException('SecurityError', 'SecurityError');
      });
      expect(readColumnVisibility().size).toBe(DEFAULT_VISIBLE_COLUMNS.length);
    });
  });

  describe('writeColumnVisibility', () => {
    it('persists the versioned single-key shape', () => {
      writeColumnVisibility(['hostname', 'status']);
      const raw = stored();
      expect(raw.v).toBe(1);
      expect(Array.isArray(raw.columns)).toBe(true);
      // Every catalog column is present exactly once.
      expect(raw.columns.map((c: { id: string }) => c.id).sort()).toEqual([...COLUMN_IDS].sort());
      const byId = new Map(raw.columns.map((c: { id: string; visible: boolean }) => [c.id, c.visible]));
      expect(byId.get('hostname')).toBe(true);
      expect(byId.get('status')).toBe(true);
      expect(byId.get('cpu')).toBe(false);
    });

    it('strips unknown ids before writing', () => {
      writeColumnVisibility(['hostname', 'mystery' as never, 'cpu']);
      const got = readColumnVisibility();
      expect(got.has('hostname')).toBe(true);
      expect(got.has('cpu')).toBe(true);
      expect(got.size).toBe(2);
    });

    it('swallows setItem exceptions', () => {
      vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
        throw new DOMException('QuotaExceededError', 'QuotaExceededError');
      });
      expect(() => writeColumnVisibility(['hostname'])).not.toThrow();
    });

    it('preserves the current order when only visibility changes', () => {
      const reordered = [...COLUMN_IDS].reverse();
      writeColumnOrder(reordered);
      writeColumnVisibility(['hostname']);
      expect(readColumnOrder()).toEqual(reordered);
    });
  });

  describe('readColumnOrder', () => {
    it('returns canonical COLUMN_IDS order when no entry is stored', () => {
      expect(readColumnOrder()).toEqual([...COLUMN_IDS]);
    });

    it('returns the stored order when complete and valid', () => {
      const reordered = [...COLUMN_IDS].reverse();
      writeColumnOrder(reordered);
      expect(readColumnOrder()).toEqual(reordered);
    });

    it('appends missing catalog ids at the end (merge-on-read)', () => {
      // Simulate a stored shape predating newer catalog columns.
      window.localStorage.setItem(
        COLUMN_STORAGE_KEY,
        JSON.stringify({ v: 1, columns: [{ id: 'hostname', visible: true }, { id: 'lastUser', visible: false }] }),
      );
      const result = readColumnOrder();
      expect(result.slice(0, 2)).toEqual(['hostname', 'lastUser']);
      expect(new Set(result).size).toBe(COLUMN_IDS.length);
      for (const id of COLUMN_IDS) {
        expect(result).toContain(id);
      }
    });

    it('strips unknown and duplicate ids and appends the rest', () => {
      window.localStorage.setItem(
        COLUMN_STORAGE_KEY,
        JSON.stringify({
          v: 1,
          columns: [
            { id: 'hostname', visible: true },
            { id: 'hostname', visible: true },
            { id: 'mystery', visible: true },
            { id: 'lastUser', visible: true },
          ],
        }),
      );
      const result = readColumnOrder();
      expect(result.slice(0, 2)).toEqual(['hostname', 'lastUser']);
      expect(new Set(result).size).toBe(COLUMN_IDS.length);
    });

    it('falls back to canonical order when JSON is malformed', () => {
      window.localStorage.setItem(COLUMN_STORAGE_KEY, '{nope');
      expect(readColumnOrder()).toEqual([...COLUMN_IDS]);
    });
  });

  describe('writeColumnOrder', () => {
    it('persists the chosen order with all missing ids appended', () => {
      writeColumnOrder(['hostname', 'lastUser']);
      expect(readColumnOrder().slice(0, 2)).toEqual(['hostname', 'lastUser']);
      expect(new Set(readColumnOrder()).size).toBe(COLUMN_IDS.length);
    });

    it('preserves each column visibility flag when only order changes', () => {
      writeColumnVisibility(['hostname', 'agentVersion']);
      writeColumnOrder([...COLUMN_IDS].reverse());
      const vis = readColumnVisibility();
      expect(vis.has('hostname')).toBe(true);
      expect(vis.has('agentVersion')).toBe(true);
      expect(vis.has('cpu')).toBe(false);
      expect(vis.size).toBe(2);
    });

    it('swallows setItem exceptions', () => {
      vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
        throw new DOMException('QuotaExceededError', 'QuotaExceededError');
      });
      expect(() => writeColumnOrder(['hostname'])).not.toThrow();
    });
  });

  describe('merge-on-read for a newly added catalog column', () => {
    it('surfaces a stored-but-incomplete list with new columns at their default visibility', () => {
      // Older client stored only a subset; a new default-visible column
      // (e.g. hostname) absent from storage must come back visible, and a
      // new default-hidden column (e.g. tags) must come back hidden.
      window.localStorage.setItem(
        COLUMN_STORAGE_KEY,
        JSON.stringify({ v: 1, columns: [{ id: 'status', visible: false }] }),
      );
      const order = readColumnOrder();
      const vis = readColumnVisibility();
      // status stays first and its stored (hidden) flag is honored.
      expect(order[0]).toBe('status');
      expect(vis.has('status')).toBe(false);
      // a default-visible catalog column missing from storage is appended visible.
      expect(vis.has('hostname')).toBe(true);
      // a default-hidden catalog column missing from storage is appended hidden.
      expect(vis.has('tags')).toBe(false);
      // full catalog is represented.
      expect(new Set(order).size).toBe(COLUMN_IDS.length);
    });
  });
});
