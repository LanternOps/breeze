import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COLUMN_IDS,
  COLUMN_VISIBILITY_STORAGE_KEY,
  DEFAULT_VISIBLE_COLUMNS,
  isValidColumnId,
  readColumnVisibility,
  writeColumnVisibility,
} from './columnVisibility';

// jsdom + Node 22 in this project does not surface window.localStorage
// (the global is intercepted before jsdom can attach its implementation).
// Same fix as pageSizePreference.test.ts: install a behaviorally
// equivalent stub on window.localStorage at the start of every test.
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
      expect(isValidColumnId('Hostname')).toBe(false); // case-sensitive
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

    it('returns the stored set when JSON is valid and every id is known', () => {
      window.localStorage.setItem(
        COLUMN_VISIBILITY_STORAGE_KEY,
        JSON.stringify(['hostname', 'status', 'agentVersion']),
      );
      const got = readColumnVisibility();
      expect(got.has('hostname')).toBe(true);
      expect(got.has('status')).toBe(true);
      expect(got.has('agentVersion')).toBe(true);
      expect(got.has('cpu')).toBe(false);
      expect(got.size).toBe(3);
    });

    it('filters out unknown ids and keeps the rest', () => {
      window.localStorage.setItem(
        COLUMN_VISIBILITY_STORAGE_KEY,
        JSON.stringify(['hostname', 'mystery', 'cpu']),
      );
      const got = readColumnVisibility();
      expect(got.has('hostname')).toBe(true);
      expect(got.has('cpu')).toBe(true);
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

    it('falls back to defaults when every stored id is unknown (empty effective set)', () => {
      window.localStorage.setItem(
        COLUMN_VISIBILITY_STORAGE_KEY,
        JSON.stringify(['gibberish-1', 'gibberish-2']),
      );
      // Without this fallback the table would render no toggleable columns,
      // which is worse UX than showing the default set.
      expect(readColumnVisibility().size).toBe(DEFAULT_VISIBLE_COLUMNS.length);
    });

    it('falls back to defaults when getItem throws (Safari private mode)', () => {
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
      expect(raw).not.toBeNull();
      const parsed = JSON.parse(raw as string);
      expect(parsed).toEqual(['hostname', 'status', 'agentVersion']);
    });

    it('strips unknown ids before writing', () => {
      writeColumnVisibility(['hostname', 'mystery' as never, 'cpu']);
      const parsed = JSON.parse(
        window.localStorage.getItem(COLUMN_VISIBILITY_STORAGE_KEY) as string,
      );
      expect(parsed).toEqual(['hostname', 'cpu']);
    });

    it('deduplicates ids', () => {
      writeColumnVisibility(['hostname', 'hostname', 'cpu']);
      const parsed = JSON.parse(
        window.localStorage.getItem(COLUMN_VISIBILITY_STORAGE_KEY) as string,
      );
      expect(parsed).toEqual(['hostname', 'cpu']);
    });

    it('swallows setItem exceptions (quota / private mode)', () => {
      vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
        throw new DOMException('QuotaExceededError', 'QuotaExceededError');
      });
      expect(() => writeColumnVisibility(['hostname'])).not.toThrow();
    });
  });
});
