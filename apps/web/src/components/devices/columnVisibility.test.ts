import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COLUMN_IDS,
  COLUMN_LABELS,
  COLUMN_STORAGE_KEY,
  DEFAULT_VISIBLE_COLUMNS,
  isValidColumnId,
  ORG_TAB_COLUMN_PRESET,
  ORG_TAB_COLUMN_STORAGE_KEY,
  readColumnOrder,
  readColumnVisibility,
  resetColumns,
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
      expect(got.has('watchdogVersion')).toBe(false);
      // #6751: helper version is opt-in, like watchdog version.
      expect(got.has('helperVersion')).toBe(false);
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

  describe('resetColumns', () => {
    it('overwrites a customized order + visibility back to catalog defaults', () => {
      // Customize both hats: reversed order and a single visible column.
      writeColumnOrder([...COLUMN_IDS].reverse());
      writeColumnVisibility(['hostname']);

      resetColumns();

      // Persisted state round-trips to canonical order and default visibility.
      expect(readColumnOrder()).toEqual([...COLUMN_IDS]);
      const vis = readColumnVisibility();
      expect(new Set(vis)).toEqual(new Set(DEFAULT_VISIBLE_COLUMNS));
      expect(vis.size).toBe(DEFAULT_VISIBLE_COLUMNS.length);
    });

    it('returns the fresh ordered list so callers can sync without a re-read', () => {
      writeColumnVisibility(['status']);
      const cols = resetColumns();
      // Return value is the contract the DeviceList handler syncs state from,
      // so it must match what was persisted: full catalog in order, default vis.
      expect(cols.map((c) => c.id)).toEqual([...COLUMN_IDS]);
      const visibleIds = cols.filter((c) => c.visible).map((c) => c.id);
      expect(new Set(visibleIds)).toEqual(new Set(DEFAULT_VISIBLE_COLUMNS));
    });

    it('still returns defaults when setItem throws (Safari private / quota)', () => {
      vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
        throw new DOMException('QuotaExceededError', 'QuotaExceededError');
      });
      const cols = resetColumns();
      expect(cols.map((c) => c.id)).toEqual([...COLUMN_IDS]);
      const visibleIds = cols.filter((c) => c.visible).map((c) => c.id);
      expect(new Set(visibleIds)).toEqual(new Set(DEFAULT_VISIBLE_COLUMNS));
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
      expect(vis.has('watchdogVersion')).toBe(false);
      // full catalog is represented.
      expect(new Set(order).size).toBe(COLUMN_IDS.length);
    });
  });

  describe('column presets', () => {
    const ORG_TAB_DEFAULTS = ['hostname', 'site', 'os', 'status', 'attention', 'cpu', 'ram', 'lastSeen'];

    it('the orgTab preset defaults to exactly hostname, site, os, status, attention, cpu, ram, lastSeen', () => {
      expect(readColumnVisibility(ORG_TAB_COLUMN_PRESET)).toEqual(new Set(ORG_TAB_DEFAULTS));
    });

    it('writes under breeze.devices.columns.orgTab and leaves breeze.devices.columns untouched', () => {
      writeColumnVisibility(['hostname'], ORG_TAB_COLUMN_PRESET);
      expect(window.localStorage.getItem(COLUMN_STORAGE_KEY)).toBeNull();
      expect(window.localStorage.getItem(ORG_TAB_COLUMN_STORAGE_KEY)).not.toBeNull();
      expect(ORG_TAB_COLUMN_STORAGE_KEY).toBe('breeze.devices.columns.orgTab');
      expect(readColumnVisibility()).toEqual(new Set(DEFAULT_VISIBLE_COLUMNS));
    });

    it("all-hidden falls back to the preset's defaults", () => {
      window.localStorage.setItem(
        ORG_TAB_COLUMN_STORAGE_KEY,
        JSON.stringify({ v: 1, columns: COLUMN_IDS.map((id) => ({ id, visible: false })) }),
      );
      expect(readColumnVisibility(ORG_TAB_COLUMN_PRESET)).toEqual(new Set(ORG_TAB_DEFAULTS));
    });

    it('resetColumns(preset) restores the preset defaults under its own key', () => {
      writeColumnVisibility(['hostname'], ORG_TAB_COLUMN_PRESET);
      const cols = resetColumns(ORG_TAB_COLUMN_PRESET);
      expect(new Set(cols.filter((c) => c.visible).map((c) => c.id))).toEqual(new Set(ORG_TAB_DEFAULTS));
      expect(readColumnVisibility(ORG_TAB_COLUMN_PRESET)).toEqual(new Set(ORG_TAB_DEFAULTS));
      expect(window.localStorage.getItem(COLUMN_STORAGE_KEY)).toBeNull();
    });
  });

  it('registers Hardware without enabling it for existing users', () => {
    expect(COLUMN_IDS).toContain('hardwareHealth');
    expect(COLUMN_LABELS.hardwareHealth).toBe('Hardware');
    expect(DEFAULT_VISIBLE_COLUMNS).not.toContain('hardwareHealth');
    expect(readColumnVisibility().has('hardwareHealth')).toBe(false);
    writeColumnVisibility([...DEFAULT_VISIBLE_COLUMNS, 'hardwareHealth']);
    expect(readColumnVisibility().has('hardwareHealth')).toBe(true);
  });

  describe('Attention column (#9038)', () => {
    it('is in the catalog, labelled, and default-visible right after Status on both presets', () => {
      expect(COLUMN_IDS).toContain('attention');
      expect(COLUMN_LABELS.attention).toBe('Attention');
      expect(DEFAULT_VISIBLE_COLUMNS[0]).toBe('hostname');
      expect(DEFAULT_VISIBLE_COLUMNS.indexOf('attention')).toBe(DEFAULT_VISIBLE_COLUMNS.indexOf('status') + 1);
      const orgTab = ORG_TAB_COLUMN_PRESET.defaultVisible;
      expect(orgTab[0]).toBe('hostname');
      expect(orgTab.indexOf('attention')).toBe(orgTab.indexOf('status') + 1);
    });

    it('sits right after Status in the catalog order a fresh user sees', () => {
      const order = readColumnOrder();
      expect(order[0]).toBe('hostname');
      expect(order.indexOf('attention')).toBe(order.indexOf('status') + 1);
      expect(readColumnVisibility().has('attention')).toBe(true);
    });

    it('leaves a saved column set in place and appends Attention at the end (no storage migration)', () => {
      const saved = COLUMN_IDS.filter((id) => id !== 'attention').reverse();
      window.localStorage.setItem(
        COLUMN_STORAGE_KEY,
        JSON.stringify({ v: 1, columns: saved.map((id) => ({ id, visible: id === 'hostname' || id === 'cpu' })) }),
      );
      const order = readColumnOrder();
      expect(order.slice(0, -1)).toEqual(saved);
      expect(order[order.length - 1]).toBe('attention');
      // A read never rewrites the stored value.
      expect(JSON.parse(window.localStorage.getItem(COLUMN_STORAGE_KEY)!).columns).toHaveLength(saved.length);
    });
  });
});
