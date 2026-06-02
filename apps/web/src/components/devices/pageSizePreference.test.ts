import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PAGE_SIZE,
  PAGE_SIZE_OPTIONS,
  PAGE_SIZE_STORAGE_KEY,
  isValidPageSize,
  readPageSizePreference,
  writePageSizePreference,
} from './pageSizePreference';

// Tiny in-memory localStorage that we install onto `window` before each
// test. This is intentional rather than relying on jsdom's bundled
// implementation: as of vitest 4 / jsdom 27 on this project, the test
// environment runs under Node 22+ which intercepts the `localStorage`
// global before jsdom can attach its own, so `window.localStorage` reads
// as `undefined`. The unit under test reads `window.localStorage`
// defensively (typeof guards) and the production app always runs in a
// browser where the real Storage API is present, so we substitute a
// behaviourally-equivalent stub here.
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

describe('pageSizePreference', () => {
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

  describe('isValidPageSize', () => {
    it('accepts every option in PAGE_SIZE_OPTIONS', () => {
      for (const opt of PAGE_SIZE_OPTIONS) {
        expect(isValidPageSize(opt)).toBe(true);
      }
    });

    it('rejects values not in PAGE_SIZE_OPTIONS', () => {
      expect(isValidPageSize(7)).toBe(false);
      expect(isValidPageSize(0)).toBe(false);
      expect(isValidPageSize(-10)).toBe(false);
      expect(isValidPageSize(1000)).toBe(false);
      expect(isValidPageSize(NaN)).toBe(false);
    });
  });

  describe('readPageSizePreference', () => {
    it('returns the fallback when localStorage has no entry', () => {
      expect(readPageSizePreference(25)).toBe(25);
    });

    it('returns the stored value when valid', () => {
      window.localStorage.setItem(PAGE_SIZE_STORAGE_KEY, '50');
      expect(readPageSizePreference()).toBe(50);
    });

    it('falls back when stored value is malformed', () => {
      window.localStorage.setItem(PAGE_SIZE_STORAGE_KEY, 'banana');
      expect(readPageSizePreference(25)).toBe(25);
    });

    it('falls back when stored value parses but is not in the allowed set', () => {
      window.localStorage.setItem(PAGE_SIZE_STORAGE_KEY, '7');
      expect(readPageSizePreference(100)).toBe(100);
    });

    it('uses DEFAULT_PAGE_SIZE when the fallback itself is not in the allowed set', () => {
      expect(readPageSizePreference(7)).toBe(DEFAULT_PAGE_SIZE);
    });

    it('returns the fallback when localStorage.getItem throws (Safari private mode)', () => {
      vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
        throw new DOMException('SecurityError', 'SecurityError');
      });
      expect(readPageSizePreference(25)).toBe(25);
    });

    it('defaults the fallback to DEFAULT_PAGE_SIZE when not supplied', () => {
      expect(readPageSizePreference()).toBe(DEFAULT_PAGE_SIZE);
    });
  });

  describe('writePageSizePreference', () => {
    it('persists a valid size as a string', () => {
      writePageSizePreference(50);
      expect(window.localStorage.getItem(PAGE_SIZE_STORAGE_KEY)).toBe('50');
    });

    it('ignores a write of an invalid size (does not clobber existing valid value)', () => {
      window.localStorage.setItem(PAGE_SIZE_STORAGE_KEY, '25');
      writePageSizePreference(7);
      expect(window.localStorage.getItem(PAGE_SIZE_STORAGE_KEY)).toBe('25');
    });

    it('swallows setItem exceptions (quota / private mode)', () => {
      vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
        throw new DOMException('QuotaExceededError', 'QuotaExceededError');
      });
      expect(() => writePageSizePreference(100)).not.toThrow();
    });
  });
});
