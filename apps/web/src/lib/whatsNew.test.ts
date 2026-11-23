import { describe, it, expect } from 'vitest';
import { semverCompare } from '@breeze/shared';
import { WHATS_NEW_ENTRIES } from './whatsNew';

// Guards the bundled entries themselves (release skill Step 0.4). The splash
// logic in whatsNewState.ts assumes newest-first, so an entry added below the
// top, or a duplicate version, silently never shows.
describe('WHATS_NEW_ENTRIES', () => {
  it('uses bare semver versions, each listed once', () => {
    const versions = WHATS_NEW_ENTRIES.map((e) => e.version);
    for (const v of versions) expect(v).toMatch(/^\d+\.\d+\.\d+$/);
    expect(new Set(versions).size).toBe(versions.length);
  });

  it('is ordered newest-first by version and by date', () => {
    for (let i = 1; i < WHATS_NEW_ENTRIES.length; i++) {
      const newer = WHATS_NEW_ENTRIES[i - 1]!;
      const older = WHATS_NEW_ENTRIES[i]!;
      expect(semverCompare(newer.version, older.version), `${newer.version} before ${older.version}`).toBeGreaterThan(0);
      expect(newer.date >= older.date, `${newer.version} dated ${newer.date} before ${older.date}`).toBe(true);
    }
  });

  it('gives every entry an ISO date, a title and 2 to 5 highlights', () => {
    for (const e of WHATS_NEW_ENTRIES) {
      expect(e.date, e.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(e.title.trim().length, e.version).toBeGreaterThan(0);
      expect(e.highlights.length, e.version).toBeGreaterThanOrEqual(2);
      expect(e.highlights.length, e.version).toBeLessThanOrEqual(5);
      for (const h of e.highlights) expect(h.trim().length, e.version).toBeGreaterThan(0);
    }
  });
});
