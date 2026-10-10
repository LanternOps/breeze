import { describe, it, expect, vi, beforeEach } from 'vitest';

const { selectRows } = vi.hoisted(() => ({ selectRows: [] as unknown[][] }));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve(selectRows.shift() ?? [])) }))
      }))
    }))
  }
}));

import {
  parseSessionSuggestionSettings,
  getSessionSuggestionSettings,
  SESSION_SUGGESTION_DEFAULTS,
  parseLocationSuggestionSettings,
  getLocationSuggestionSettings,
  LOCATION_SUGGESTION_DEFAULTS,
} from './timeSuggestionSettings';

beforeEach(() => { selectRows.length = 0; });

describe('parseSessionSuggestionSettings', () => {
  it('defaults OFF with 120s / 10min when the block is absent', () => {
    expect(parseSessionSuggestionSettings({})).toEqual(SESSION_SUGGESTION_DEFAULTS);
    expect(parseSessionSuggestionSettings(null)).toEqual(SESSION_SUGGESTION_DEFAULTS);
    expect(SESSION_SUGGESTION_DEFAULTS.enabled).toBe(false);
  });
  it('reads timeTracking.sessionSuggestions and ignores junk types', () => {
    expect(parseSessionSuggestionSettings({ timeTracking: { sessionSuggestions: { enabled: true, minSessionSeconds: 300, mergeGapMinutes: 'x' } } }))
      .toEqual({ enabled: true, minSessionSeconds: 300, mergeGapMinutes: 10 });
  });
  it('a stored false is honoured as false (not treated as absent) (#3608)', () => {
    expect(parseSessionSuggestionSettings({ timeTracking: { sessionSuggestions: { enabled: false } } }).enabled).toBe(false);
  });
});

describe('getSessionSuggestionSettings', () => {
  it('returns the parsed block and the partner timezone', async () => {
    selectRows.push([{ settings: { timeTracking: { sessionSuggestions: { enabled: true } } }, timezone: 'Europe/Berlin' }]);
    await expect(getSessionSuggestionSettings('p-1')).resolves.toEqual({
      settings: { enabled: true, minSessionSeconds: 120, mergeGapMinutes: 10 },
      timezone: 'Europe/Berlin'
    });
  });
  it('falls back to UTC + defaults when the partner row is not visible', async () => {
    selectRows.push([]);
    await expect(getSessionSuggestionSettings('p-1')).resolves.toEqual({ settings: SESSION_SUGGESTION_DEFAULTS, timezone: 'UTC' });
  });
});

describe('parseLocationSuggestionSettings', () => {
  it('defaults OFF at 150 m', () => {
    expect(LOCATION_SUGGESTION_DEFAULTS).toEqual({ enabled: false, defaultRadiusM: 150 });
  });
  it.each([
    [undefined, { enabled: false, defaultRadiusM: 150 }],
    [{ timeTracking: { locationSuggestions: { enabled: true } } }, { enabled: true, defaultRadiusM: 150 }],
    [{ timeTracking: { locationSuggestions: { enabled: 'true' } } }, { enabled: false, defaultRadiusM: 150 }],
    [{ timeTracking: { locationSuggestions: { enabled: false, defaultRadiusM: 300 } } }, { enabled: false, defaultRadiusM: 300 }],
    [{ timeTracking: { locationSuggestions: { enabled: true, defaultRadiusM: 5000 } } }, { enabled: true, defaultRadiusM: 150 }],
    [{ timeTracking: { locationSuggestions: { enabled: true, defaultRadiusM: 20 } } }, { enabled: true, defaultRadiusM: 150 }],
    [{ timeTracking: { locationSuggestions: { enabled: true, defaultRadiusM: 100.5 } } }, { enabled: true, defaultRadiusM: 150 }],
  ])('parseLocationSuggestionSettings(%j)', (raw, expected) => {
    expect(parseLocationSuggestionSettings(raw)).toEqual(expected);
  });
});

describe('getLocationSuggestionSettings', () => {
  it('returns the parsed block', async () => {
    selectRows.push([{ settings: { timeTracking: { locationSuggestions: { enabled: true, defaultRadiusM: 250 } } } }]);
    await expect(getLocationSuggestionSettings('p-1')).resolves.toEqual({ enabled: true, defaultRadiusM: 250 });
  });
  it('falls back to defaults when the partner row is not visible', async () => {
    selectRows.push([]);
    await expect(getLocationSuggestionSettings('p-1')).resolves.toEqual(LOCATION_SUGGESTION_DEFAULTS);
  });
});
