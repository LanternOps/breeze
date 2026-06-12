import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_DENSITY,
  DENSITY_OPTIONS,
  DENSITY_STORAGE_KEY,
  applyDensityAttribute,
  densityTableClasses,
  isValidDensity,
  readDensity,
  subscribeDensity,
  writeDensity,
} from './density';

// Tiny in-memory localStorage installed onto `window` before each test.
// Same rationale as pageSizePreference.test.ts: under Node 22+ the
// `localStorage` global is intercepted before jsdom attaches its own, so
// `window.localStorage` reads as `undefined`. The unit under test guards
// with `typeof`, and production always runs in a real browser, so we
// substitute a behaviourally-equivalent stub here.
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

describe('density', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'localStorage', {
      value: makeMemoryStorage(),
      writable: true,
      configurable: true,
    });
    document.documentElement.removeAttribute('data-density');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('isValidDensity', () => {
    it('accepts every option in DENSITY_OPTIONS', () => {
      for (const opt of DENSITY_OPTIONS) {
        expect(isValidDensity(opt)).toBe(true);
      }
    });

    it('rejects values not in DENSITY_OPTIONS', () => {
      expect(isValidDensity('cozy')).toBe(false);
      expect(isValidDensity('')).toBe(false);
      expect(isValidDensity(2)).toBe(false);
      expect(isValidDensity(null)).toBe(false);
      expect(isValidDensity(undefined)).toBe(false);
      expect(isValidDensity({})).toBe(false);
    });
  });

  describe('readDensity', () => {
    it('returns DEFAULT_DENSITY when localStorage has no entry', () => {
      expect(readDensity()).toBe(DEFAULT_DENSITY);
    });

    it('returns the stored value when valid', () => {
      window.localStorage.setItem(DENSITY_STORAGE_KEY, 'dense');
      expect(readDensity()).toBe('dense');
    });

    it('falls back to DEFAULT_DENSITY when the stored value is not recognized', () => {
      window.localStorage.setItem(DENSITY_STORAGE_KEY, 'banana');
      expect(readDensity()).toBe(DEFAULT_DENSITY);
    });

    it('returns DEFAULT_DENSITY when localStorage.getItem throws (Safari private mode)', () => {
      vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
        throw new DOMException('SecurityError', 'SecurityError');
      });
      expect(readDensity()).toBe(DEFAULT_DENSITY);
    });
  });

  describe('writeDensity', () => {
    it('persists the chosen density', () => {
      writeDensity('compact');
      expect(window.localStorage.getItem(DENSITY_STORAGE_KEY)).toBe('compact');
      expect(readDensity()).toBe('compact');
    });

    it('mirrors the value to the data-density attribute on <html>', () => {
      writeDensity('dense');
      expect(document.documentElement.getAttribute('data-density')).toBe('dense');
    });

    it('ignores an invalid value (no persist, no attribute change)', () => {
      writeDensity('cozy' as never);
      expect(window.localStorage.getItem(DENSITY_STORAGE_KEY)).toBeNull();
      expect(document.documentElement.getAttribute('data-density')).toBeNull();
    });

    it('still applies the attribute and notifies when setItem throws (quota/SecurityError)', () => {
      vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
        throw new DOMException('QuotaExceededError', 'QuotaExceededError');
      });
      const seen: string[] = [];
      const unsub = subscribeDensity((v) => seen.push(v));
      writeDensity('compact');
      expect(document.documentElement.getAttribute('data-density')).toBe('compact');
      expect(seen).toEqual(['compact']);
      unsub();
    });
  });

  describe('applyDensityAttribute', () => {
    it('sets data-density on documentElement', () => {
      applyDensityAttribute('compact');
      expect(document.documentElement.getAttribute('data-density')).toBe('compact');
    });
  });

  describe('subscribeDensity', () => {
    it('invokes the subscriber with the new value on writeDensity', () => {
      const seen: string[] = [];
      const unsub = subscribeDensity((v) => seen.push(v));
      writeDensity('dense');
      writeDensity('compact');
      expect(seen).toEqual(['dense', 'compact']);
      unsub();
    });

    it('stops invoking after unsubscribe', () => {
      const seen: string[] = [];
      const unsub = subscribeDensity((v) => seen.push(v));
      writeDensity('dense');
      unsub();
      writeDensity('compact');
      expect(seen).toEqual(['dense']);
    });

    it('a throwing subscriber does not break writeDensity or other subscribers', () => {
      const seen: string[] = [];
      const unsubBad = subscribeDensity(() => {
        throw new Error('boom');
      });
      const unsubGood = subscribeDensity((v) => seen.push(v));
      expect(() => writeDensity('dense')).not.toThrow();
      expect(seen).toEqual(['dense']);
      unsubBad();
      unsubGood();
    });
  });

  describe('densityTableClasses', () => {
    it('returns no overrides for comfortable (matches pre-feature default)', () => {
      expect(densityTableClasses('comfortable')).toBe('');
    });

    it('tightens vertical padding for compact', () => {
      expect(densityTableClasses('compact')).toBe('[&_td]:py-2 [&_th]:py-2');
    });

    it('tightens padding and font size for dense', () => {
      expect(densityTableClasses('dense')).toBe('[&_td]:py-1.5 [&_th]:py-1.5 [&_td]:text-xs');
    });
  });
});
