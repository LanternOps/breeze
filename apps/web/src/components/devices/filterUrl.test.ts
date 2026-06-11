import { describe, it, expect, beforeEach } from 'vitest';
import {
  encodeFilterToHash,
  decodeFilterFromHash,
  writeFilterToHash,
  isFiltersV2Enabled,
} from './filterUrl';
import type { FilterConditionGroup } from '@breeze/shared';

const sampleFilter: FilterConditionGroup = {
  operator: 'AND',
  conditions: [{ field: 'hostname', operator: 'contains', value: 'web' }],
};

beforeEach(() => {
  window.localStorage.clear();
  history.replaceState(null, '', '/devices');
});

describe('filterUrl hash encode/decode', () => {
  it('round-trips a filter through the hash (base64url under the filtersV2 key)', () => {
    const encoded = encodeFilterToHash(sampleFilter);
    expect(encoded.startsWith('filtersV2=')).toBe(true);
    const decoded = decodeFilterFromHash(`#${encoded}`);
    expect(decoded).toEqual(sampleFilter);
  });

  it('encodes an empty/no filter as the empty string', () => {
    expect(encodeFilterToHash(null)).toBe('');
    expect(encodeFilterToHash({ operator: 'AND', conditions: [] })).toBe('');
  });

  it('writeFilterToHash preserves unrelated hash fragments', () => {
    history.replaceState(null, '', '/devices#add-device');
    writeFilterToHash(sampleFilter);
    expect(window.location.hash).toContain('add-device');
    expect(window.location.hash).toContain('filtersV2=');
  });
});

describe('isFiltersV2Enabled flag (hash, not query param)', () => {
  it('defaults to on', () => {
    expect(isFiltersV2Enabled()).toBe(true);
  });

  it('opts out via #filtersV2Flag=off (one-off) without colliding with the value key', () => {
    history.replaceState(null, '', '/devices#filtersV2Flag=off');
    expect(isFiltersV2Enabled()).toBe(false);
    history.replaceState(null, '', '/devices#filtersV2Flag=0');
    expect(isFiltersV2Enabled()).toBe(false);
  });

  it('forces on via #filtersV2Flag=on even with a sticky off', () => {
    window.localStorage.setItem('breeze.filtersV2', 'off');
    history.replaceState(null, '', '/devices#filtersV2Flag=on');
    expect(isFiltersV2Enabled()).toBe(true);
  });

  it('honors the sticky localStorage opt-out when no hash flag is present', () => {
    window.localStorage.setItem('breeze.filtersV2', 'off');
    expect(isFiltersV2Enabled()).toBe(false);
  });

  it('a query param no longer toggles the flag (CLAUDE.md: hash, not query)', () => {
    history.replaceState(null, '', '/devices?filtersV2=0');
    expect(isFiltersV2Enabled()).toBe(true);
  });

  it('the flag key does not collide with an active filter value in the hash', () => {
    const encoded = encodeFilterToHash(sampleFilter); // filtersV2=<base64>
    history.replaceState(null, '', `/devices#${encoded}`);
    // Value present, no flag → still enabled, and the value still decodes.
    expect(isFiltersV2Enabled()).toBe(true);
    expect(decodeFilterFromHash(window.location.hash)).toEqual(sampleFilter);
  });
});
