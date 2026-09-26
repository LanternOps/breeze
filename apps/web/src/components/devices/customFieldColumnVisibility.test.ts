import { beforeEach, describe, expect, it } from 'vitest';
import { readVisibleCustomFieldKeys, writeVisibleCustomFieldKeys } from './customFieldColumnVisibility';

describe('customFieldColumnVisibility (#6594)', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('defaults to no visible custom columns', () => {
    expect(readVisibleCustomFieldKeys()).toEqual(new Set());
  });

  it('round-trips a written set', () => {
    writeVisibleCustomFieldKeys(['bdr_windows_activation', 'asset_owner']);
    expect(readVisibleCustomFieldKeys()).toEqual(new Set(['bdr_windows_activation', 'asset_owner']));
  });

  it('dedupes on write', () => {
    writeVisibleCustomFieldKeys(['a', 'a', 'b']);
    expect(readVisibleCustomFieldKeys()).toEqual(new Set(['a', 'b']));
  });

  it('degrades to empty on malformed storage rather than throwing', () => {
    window.localStorage.setItem('breeze.devices.customColumns', '{not json');
    expect(readVisibleCustomFieldKeys()).toEqual(new Set());
  });
});
