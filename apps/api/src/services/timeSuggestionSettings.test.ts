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
