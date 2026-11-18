import { describe, it, expect } from 'vitest';
import {
  UNATTENDED_NOTE_MAX_ACTIVE_PER_DEVICE,
  UNATTENDED_NOTE_MAX_DETAILS_CHARS,
  UNATTENDED_NOTE_MAX_EXPIRY_DAYS,
  unattendedNoteContentError,
  unattendedNoteExpiryDays,
} from './deviceNoteBounds';

describe('deviceNoteBounds (#12140)', () => {
  it('matches the card-free note bounds from #11987', () => {
    expect(UNATTENDED_NOTE_MAX_ACTIVE_PER_DEVICE).toBe(8);
    expect(UNATTENDED_NOTE_MAX_DETAILS_CHARS).toBe(200);
    expect(UNATTENDED_NOTE_MAX_EXPIRY_DAYS).toBe(30);
  });

  it('measures details as 2-space pretty JSON, not compact', () => {
    // Compact fits the cap; pretty-printed does not.
    const details = Object.fromEntries(Array.from({ length: 19 }, (_v, i) => [`k${String(i).padStart(2, '0')}`, 'v']));
    expect(JSON.stringify(details).length).toBeLessThanOrEqual(UNATTENDED_NOTE_MAX_DETAILS_CHARS);
    expect(JSON.stringify(details, null, 2).length).toBeGreaterThan(UNATTENDED_NOTE_MAX_DETAILS_CHARS);
    expect(unattendedNoteContentError({ details })).toMatch(/details/);
  });

  it('refuses details that cannot be serialised', () => {
    const details: Record<string, unknown> = {};
    details.self = details;
    expect(unattendedNoteContentError({ details })).toMatch(/details/);
    expect(unattendedNoteContentError({ details: { n: 1n } })).toMatch(/details/);
  });

  it('refuses details that are not a JSON object', () => {
    for (const details of [['a'], 'text', 7, true]) {
      expect(unattendedNoteContentError({ details })).toMatch(/details must be a JSON object/);
    }
  });

  it('accepts no details, null details and small details', () => {
    expect(unattendedNoteContentError({})).toBeNull();
    expect(unattendedNoteContentError({ details: null })).toBeNull();
    expect(unattendedNoteContentError({ details: { a: 1 } })).toBeNull();
  });

  it('bounds the expiry to whole days in 1..30', () => {
    expect(unattendedNoteContentError({ expiresInDays: 30 })).toBeNull();
    expect(unattendedNoteContentError({ expiresInDays: 1 })).toBeNull();
    for (const bad of [31, 365, 0, -1, 1.5, '7', Number.NaN]) {
      expect(unattendedNoteContentError({ expiresInDays: bad })).toMatch(/expiresInDays/);
    }
  });

  it('defaults a missing expiry to the cap', () => {
    expect(unattendedNoteExpiryDays({})).toBe(30);
    expect(unattendedNoteExpiryDays({ expiresInDays: null })).toBe(30);
    expect(unattendedNoteExpiryDays({ expiresInDays: 4 })).toBe(4);
  });
});
