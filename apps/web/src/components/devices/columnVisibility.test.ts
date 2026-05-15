import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COLUMN_IDS,
  COLUMN_ORDER_STORAGE_KEY,
  COLUMN_VISIBILITY_STORAGE_KEY,
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

    it('returns the stored set when valid', () => {
      window.localStorage.setItem(
        COLUMN_VISIBILITY_STORAGE_KEY,
        JSON.stringify(['hostname', 'status', 'agentVersion']),
      );
      const got = readColumnVisibility();
      expect(got.has('hostname')).toBe(true);
      expect(got.has('agentVersion')).toBe(true);
      expect(got.has('cpu')).toBe(false);
      expect(got.size).toBe(3);
    });

    it('filters out unknown ids', () => {
      window.localStorage.setItem(
        COLUMN_VISIBILITY_STORAGE_KEY,
        JSON.stringify(['hostname', 'mystery', 'cpu']),
      );
      const got = readColumnVisibility();
      expect(got.size).toBe(2);
    });

    it('falls back to defaults when JSON is malformed', () => {
      window.localStorage.setItem(COLUMN_VISIBILITY_STORAGE_KEY, '{not valid json');
      expect(readColumnVisibility().size).toBe(DEFAULT_VISIBLE_COLUMNS.length);
    });

    it('falls back to defaults when stored value is not an array', () => {
      window.localStorage.setItem(COLUMN_VISIBILITY_STORAGE_KEY, JSON.stringify({ hostname: true }));
      expect(readColumnVisibility().size).toBe(DEFAULT_VISIBLE_COLUMNS.length);
    });

    it('falls back to defaults when every stored id is unknown', () => {
      window.localStorage.setItem(
        COLUMN_VISIBILITY_STORAGE_KEY,
        JSON.stringify(['gibberish-1', 'gibberish-2']),
      );
      expect(readColumnVisibility().size).toBe(DEFAULT_VISIBLE_COLUMNS.length);
    });

    it('falls back when getItem throws (Safari private mode)', () => {
      vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
        throw new DOMException('SecurityError', 'SecurityError');
      });
      expect(readColumnVisibility().size).toBe(DEFAULT_VISIBLE_COLUMNS.length);
    });
  });

  describe('writeColumnVisibility', () => {
    it('persists valid ids as a JSON array', () => {
      writeColumnVisibility(['hostname', 'status', 'agentVersion']);
      const raw = window.localStorage.getItem(COLUMN_VISIBILITY_STORAGE_KEY);
      expect(JSON.parse(raw as string)).toEqual(['hostname', 'status', 'agentVersion']);
    });

    it('strips unknown ids before writing', () => {
      writeColumnVisibility(['hostname', 'mystery' as never, 'cpu']);
      const parsed = JSON.parse(window.localStorage.getItem(COLUMN_VISIBILITY_STORAGE_KEY) as string);
      expect(parsed).toEqual(['hostname', 'cpu']);
    });

    it('dedupes ids', () => {
      writeColumnVisibility(['hostname', 'hostname', 'cpu']);
      const parsed = JSON.parse(window.localStorage.getItem(COLUMN_VISIBILITY_STORAGE_KEY) as string);
      expect(parsed).toEqual(['hostname', 'cpu']);
    });

    it('swallows setItem exceptions', () => {
      vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
        throw new DOMException('QuotaExceededError', 'QuotaExceededError');
      });
      expect(() => writeColumnVisibility(['hostname'])).not.toThrow();
    });
  });

  describe('readColumnOrder', () => {
    it('returns canonical COLUMN_IDS order when no entry is stored', () => {
      expect(readColumnOrder()).toEqual([...COLUMN_IDS]);
    });

    it('returns the stored order when complete and valid', () => {
      const stored = [...COLUMN_IDS].reverse();
      window.localStorage.setItem(COLUMN_ORDER_STORAGE_KEY, JSON.stringify(stored));
      expect(readColumnOrder()).toEqual(stored);
    });

    it('appends missing ids at the end when stored order is partial', () => {
      window.localStorage.setItem(
        COLUMN_ORDER_STORAGE_KEY,
        JSON.stringify(['hostname', 'lastUser']),
      );
      const result = readColumnOrder();
      expect(result.slice(0, 2)).toEqual(['hostname', 'lastUser']);
      // every catalog id is still present exactly once
      expect(new Set(result).size).toBe(COLUMN_IDS.length);
      for (const id of COLUMN_IDS) {
        expect(result).toContain(id);
      }
    });

    it('strips unknown and duplicate ids and appends the rest', () => {
      window.localStorage.setItem(
        COLUMN_ORDER_STORAGE_KEY,
        JSON.stringify(['hostname', 'hostname', 'mystery', 'lastUser']),
      );
      const result = readColumnOrder();
      expect(result.slice(0, 2)).toEqual(['hostname', 'lastUser']);
      expect(new Set(result).size).toBe(COLUMN_IDS.length);
    });

    it('falls back to canonical order when JSON is malformed', () => {
      window.localStorage.setItem(COLUMN_ORDER_STORAGE_KEY, '{nope');
      expect(readColumnOrder()).toEqual([...COLUMN_IDS]);
    });

    it('falls back when getItem throws', () => {
      vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
        throw new DOMException('SecurityError', 'SecurityError');
      });
      expect(readColumnOrder()).toEqual([...COLUMN_IDS]);
    });
  });

  describe('writeColumnOrder', () => {
    it('persists the chosen order with all missing ids appended', () => {
      writeColumnOrder(['hostname', 'lastUser']);
      const parsed = JSON.parse(window.localStorage.getItem(COLUMN_ORDER_STORAGE_KEY) as string);
      expect(parsed.slice(0, 2)).toEqual(['hostname', 'lastUser']);
      expect(new Set(parsed).size).toBe(COLUMN_IDS.length);
    });

    it('strips unknown and duplicate ids', () => {
      writeColumnOrder(['hostname', 'hostname', 'mystery' as never, 'cpu']);
      const parsed = JSON.parse(window.localStorage.getItem(COLUMN_ORDER_STORAGE_KEY) as string);
      expect(parsed.slice(0, 2)).toEqual(['hostname', 'cpu']);
      expect(new Set(parsed).size).toBe(COLUMN_IDS.length);
    });

    it('swallows setItem exceptions', () => {
      vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
        throw new DOMException('QuotaExceededError', 'QuotaExceededError');
      });
      expect(() => writeColumnOrder(['hostname'])).not.toThrow();
    });
  });
});
