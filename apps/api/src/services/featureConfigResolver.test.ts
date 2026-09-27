import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

// These tests exercise pure helpers; prevent database initialization.
vi.mock('../db', () => ({ db: {} }));

import {
  isInMaintenanceWindow,
  createSystemAuthContext,
} from './featureConfigResolver';

// Helper to build a maintenance settings object.
// Cast as `any` because the Drizzle inferred type expects table-specific columns;
// `isInMaintenanceWindow` only reads the fields we provide here.
function makeSettings(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'maint-1',
    featureLinkId: 'fl-1',
    timezone: 'UTC',
    durationHours: 2,
    recurrence: 'daily',
    windowStart: null,
    suppressAlerts: true,
    suppressPatching: true,
    suppressAutomations: false,
    suppressScripts: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('isInMaintenanceWindow', () => {
  // AI patch agent W04 (#5750): the wall clock is rendered in UTC field
  // space, so the SERVER's zone never enters the arithmetic. Pinned with
  // TZ-sensitive dates: on a US-zone server the old local-constructor
  // rendering turned 02:00 UTC into 03:00 on the US spring-forward Sunday.
  describe('server-timezone independence', () => {
    it('evaluates a UTC 02:00 window on the US spring-forward Sunday exactly at 02:00Z', () => {
      const settings = makeSettings({ windowStart: '02:00' });
      expect(isInMaintenanceWindow(settings, new Date('2026-03-08T01:59:59Z')).active).toBe(false);
      expect(isInMaintenanceWindow(settings, new Date('2026-03-08T02:00:00Z')).active).toBe(true);
      expect(isInMaintenanceWindow(settings, new Date('2026-03-08T03:59:59Z')).active).toBe(true);
      expect(isInMaintenanceWindow(settings, new Date('2026-03-08T04:00:00Z')).active).toBe(false);
    });

    it("reads a once window's naive datetime as wall time in the WINDOW's zone", () => {
      const settings = makeSettings({ recurrence: 'once', timezone: 'Asia/Kolkata', windowStart: '2026-03-15T02:00:00' });
      // 02:00 IST is 20:30Z the previous day.
      expect(isInMaintenanceWindow(settings, new Date('2026-03-14T20:29:59Z')).active).toBe(false);
      expect(isInMaintenanceWindow(settings, new Date('2026-03-14T20:30:00Z')).active).toBe(true);
      expect(isInMaintenanceWindow(settings, new Date('2026-03-14T22:30:00Z')).active).toBe(false);
    });

    it("renders a once window carrying an explicit Z into the window's zone (it names an instant)", () => {
      const settings = makeSettings({ recurrence: 'once', timezone: 'Asia/Kolkata', windowStart: '2026-03-15T02:00:00Z' });
      expect(isInMaintenanceWindow(settings, new Date('2026-03-15T01:59:59Z')).active).toBe(false);
      expect(isInMaintenanceWindow(settings, new Date('2026-03-15T02:00:00Z')).active).toBe(true);
    });
  });

  // ============================================
  // Daily recurrence
  // ============================================

  describe('daily recurrence', () => {
    it('returns active when now is within the daily window (midnight + duration)', () => {
      // 2026-02-17 00:30 UTC — within midnight + 2h window
      const now = new Date('2026-02-17T00:30:00Z');
      const result = isInMaintenanceWindow(makeSettings(), now);
      expect(result.active).toBe(true);
      expect(result.suppressAlerts).toBe(true);
      expect(result.suppressPatching).toBe(true);
    });

    it('returns inactive when now is after the daily window', () => {
      // 2026-02-17 03:00 UTC — outside midnight + 2h window
      const now = new Date('2026-02-17T03:00:00Z');
      const result = isInMaintenanceWindow(makeSettings(), now);
      expect(result.active).toBe(false);
    });

    it('returns inactive right at the window end (exclusive upper bound)', () => {
      // localNow would be midnight + 2h exactly => NOT in window (< windowEnd)
      const now = new Date('2026-02-17T02:00:00Z');
      const result = isInMaintenanceWindow(makeSettings(), now);
      expect(result.active).toBe(false);
    });

    it('returns active right at midnight (inclusive lower bound)', () => {
      const now = new Date('2026-02-17T00:00:00Z');
      const result = isInMaintenanceWindow(makeSettings(), now);
      expect(result.active).toBe(true);
    });

    it('handles large duration that covers most of the day', () => {
      const settings = makeSettings({ durationHours: 23 });
      const now = new Date('2026-02-17T22:59:00Z');
      const result = isInMaintenanceWindow(settings, now);
      expect(result.active).toBe(true);
    });
  });

  // ============================================
  // Weekly recurrence
  // ============================================

  describe('weekly recurrence', () => {
    it('returns active on Sunday within the window', () => {
      // 2026-02-15 is a Sunday
      const now = new Date('2026-02-15T01:00:00Z');
      const settings = makeSettings({ recurrence: 'weekly', durationHours: 4 });
      const result = isInMaintenanceWindow(settings, now);
      expect(result.active).toBe(true);
    });

    it('returns inactive on Wednesday for a 4h weekly window', () => {
      // 2026-02-18 is a Wednesday — far from Sunday
      const now = new Date('2026-02-18T01:00:00Z');
      const settings = makeSettings({ recurrence: 'weekly', durationHours: 4 });
      const result = isInMaintenanceWindow(settings, now);
      expect(result.active).toBe(false);
    });

    it('returns active mid-week if duration spans multiple days', () => {
      // 2026-02-15 is Sunday, duration 120h (5 days) → active through Thursday
      const now = new Date('2026-02-18T12:00:00Z'); // Wednesday
      const settings = makeSettings({ recurrence: 'weekly', durationHours: 120 });
      const result = isInMaintenanceWindow(settings, now);
      expect(result.active).toBe(true);
    });
  });

  // ============================================
  // Monthly recurrence
  // ============================================

  describe('monthly recurrence', () => {
    it('returns active on the 1st within the window', () => {
      const now = new Date('2026-02-01T01:00:00Z');
      const settings = makeSettings({ recurrence: 'monthly', durationHours: 4 });
      const result = isInMaintenanceWindow(settings, now);
      expect(result.active).toBe(true);
    });

    it('returns inactive on the 5th for a 4h monthly window', () => {
      const now = new Date('2026-02-05T01:00:00Z');
      const settings = makeSettings({ recurrence: 'monthly', durationHours: 4 });
      const result = isInMaintenanceWindow(settings, now);
      expect(result.active).toBe(false);
    });

    it('returns active if duration extends past the 1st', () => {
      // 1st midnight + 72h => active until 4th midnight
      const now = new Date('2026-02-03T12:00:00Z');
      const settings = makeSettings({ recurrence: 'monthly', durationHours: 72 });
      const result = isInMaintenanceWindow(settings, now);
      expect(result.active).toBe(true);
    });
  });

  // ============================================
  // Once recurrence
  // ============================================

  describe('once recurrence', () => {
    it('returns active when now is within the one-time window', () => {
      // `once` compares localNow (no TZ suffix → system local) against windowStart (UTC).
      // Use a windowStart far enough in the past with large duration to be TZ-safe.
      const windowStart = new Date('2026-02-17T00:00:00Z');
      const settings = makeSettings({
        recurrence: 'once',
        windowStart: windowStart.toISOString(),
        durationHours: 48,
      });
      // now = Feb 17 12:00 UTC, which is within [Feb 17 00:00Z .. Feb 19 00:00Z)
      const now = new Date('2026-02-17T12:00:00Z');
      const result = isInMaintenanceWindow(settings, now);
      expect(result.active).toBe(true);
    });

    it('returns inactive when now is after the one-time window', () => {
      const settings = makeSettings({
        recurrence: 'once',
        windowStart: '2026-02-10T10:00:00Z',
        durationHours: 1,
      });
      // now = Feb 17 is well past the Feb 10 window
      const now = new Date('2026-02-17T12:00:00Z');
      const result = isInMaintenanceWindow(settings, now);
      expect(result.active).toBe(false);
    });

    it('returns inactive when windowStart is null', () => {
      const settings = makeSettings({
        recurrence: 'once',
        windowStart: null,
      });
      const result = isInMaintenanceWindow(settings, new Date());
      expect(result.active).toBe(false);
    });

    it('returns inactive when windowStart is invalid', () => {
      const settings = makeSettings({
        recurrence: 'once',
        windowStart: 'not-a-date',
      });
      const result = isInMaintenanceWindow(settings, new Date());
      expect(result.active).toBe(false);
    });
  });

  // ============================================
  // Timezone handling
  // ============================================

  describe('timezone handling', () => {
    it('converts to the configured timezone before evaluating', () => {
      // 2026-02-17T05:30:00Z => 2026-02-17T00:30:00 in America/New_York (EST = UTC-5)
      // Daily window: midnight + 2h → 00:30 is inside the window
      const now = new Date('2026-02-17T05:30:00Z');
      const settings = makeSettings({ timezone: 'America/New_York' });
      const result = isInMaintenanceWindow(settings, now);
      expect(result.active).toBe(true);
    });

    it('falls back gracefully on invalid timezone and logs a warning', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const now = new Date('2026-02-17T01:00:00Z');
      const settings = makeSettings({ timezone: 'Invalid/Zone' });
      const result = isInMaintenanceWindow(settings, now);
      expect(typeof result.active).toBe('boolean');
      expect(typeof result.suppressAlerts).toBe('boolean');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Invalid timezone'),
        expect.anything()
      );
      warnSpy.mockRestore();
    });

    it('uses UTC when timezone is empty string', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const now = new Date('2026-02-17T01:00:00Z');
      const settings = makeSettings({ timezone: '' });
      const result = isInMaintenanceWindow(settings, now);
      expect(result.active).toBe(true);
      // Empty string falls back to UTC silently (no warning)
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  // ============================================
  // windowEndsAt (#3207)
  // ============================================

  // The close of the window is the ceiling on a reboot deferral deadline — a
  // user may not postpone a maintenance-window restart past the end of the
  // window. The projection that produces it is subtle: windowStart, windowEnd
  // and localNow are wall-clock times rendered as naive Dates, so only their
  // DIFFERENCE is meaningful; it has to be added back onto the real `now` to
  // become an instant. A wrong projection is silent — it would either grant
  // deferral time past the real close or truncate it — so it is pinned here
  // rather than left to the comment.
  describe('windowEndsAt', () => {
    it('is null whenever the window is inactive', () => {
      const now = new Date('2026-02-17T03:00:00Z');
      expect(isInMaintenanceWindow(makeSettings(), now).windowEndsAt).toBeNull();
    });

    it('is null for an unknown recurrence', () => {
      const now = new Date('2026-02-17T00:30:00Z');
      const settings = makeSettings({ recurrence: 'fortnightly' });
      expect(isInMaintenanceWindow(settings, now).windowEndsAt).toBeNull();
    });

    it('is the real instant the active daily window closes', () => {
      // Daily window is midnight + 2h in UTC; at 00:30 it closes at 02:00Z.
      const now = new Date('2026-02-17T00:30:00Z');
      const result = isInMaintenanceWindow(makeSettings(), now);
      expect(result.active).toBe(true);
      expect(result.windowEndsAt?.toISOString()).toBe('2026-02-17T02:00:00.000Z');
    });

    it('always lies in the future while the window is active', () => {
      for (const iso of ['2026-02-17T00:00:00Z', '2026-02-17T00:30:00Z', '2026-02-17T01:59:00Z']) {
        const now = new Date(iso);
        const result = isInMaintenanceWindow(makeSettings(), now);
        expect(result.active, iso).toBe(true);
        expect(result.windowEndsAt!.getTime(), iso).toBeGreaterThan(now.getTime());
      }
    });

    it('is a UTC instant, not a wall-clock time, under a non-UTC timezone', () => {
      // 05:30Z is 00:30 in America/New_York (EST, UTC-5). The window closes at
      // 02:00 LOCAL, i.e. 07:00Z — NOT 02:00Z. Returning the naive wall-clock
      // Date here would be 5 hours early and silently cut deferral short.
      const now = new Date('2026-02-17T05:30:00Z');
      const settings = makeSettings({ timezone: 'America/New_York' });
      const result = isInMaintenanceWindow(settings, now);
      expect(result.active).toBe(true);
      expect(result.windowEndsAt?.toISOString()).toBe('2026-02-17T07:00:00.000Z');
    });

    it('stays consistent with the remaining duration across timezones', () => {
      // Same offset into the window in two zones => same time remaining.
      const utc = isInMaintenanceWindow(makeSettings(), new Date('2026-02-17T00:30:00Z'));
      const nyc = isInMaintenanceWindow(
        makeSettings({ timezone: 'America/New_York' }),
        new Date('2026-02-17T05:30:00Z')
      );
      const remaining = (r: typeof utc, now: string) => r.windowEndsAt!.getTime() - Date.parse(now);
      expect(remaining(nyc, '2026-02-17T05:30:00Z')).toBe(remaining(utc, '2026-02-17T00:30:00Z'));
    });
  });

  // ============================================
  // Suppress flags
  // ============================================

  describe('suppress flags', () => {
    it('returns all suppress flags as configured when active', () => {
      const now = new Date('2026-02-17T00:30:00Z');
      const settings = makeSettings({
        suppressAlerts: false,
        suppressPatching: true,
        suppressAutomations: true,
        suppressScripts: false,
      });
      const result = isInMaintenanceWindow(settings, now);
      expect(result.active).toBe(true);
      expect(result.suppressAlerts).toBe(false);
      expect(result.suppressPatching).toBe(true);
      expect(result.suppressAutomations).toBe(true);
      expect(result.suppressScripts).toBe(false);
    });

    it('returns all suppress flags as false when inactive', () => {
      const now = new Date('2026-02-17T05:00:00Z');
      const result = isInMaintenanceWindow(makeSettings(), now);
      expect(result.active).toBe(false);
      expect(result.suppressAlerts).toBe(false);
      expect(result.suppressPatching).toBe(false);
      expect(result.suppressAutomations).toBe(false);
      expect(result.suppressScripts).toBe(false);
    });
  });

  // ============================================
  // Recurring start time (issue #4224)
  // ============================================

  // Before #4224 every recurring window was hardcoded to local midnight and
  // `windowStart` was read for `once` only, so a policy saying "daily, 2h,
  // Europe/Warsaw" silently ran 00:00-02:00 with no way to say otherwise.
  // `windowStart` now carries an "HH:MM" time-of-day for the recurring
  // cadences, and the evaluator anchors to the most recent occurrence at or
  // before now (so a window may have opened in the *previous* period).
  describe('recurring start time', () => {
    describe('daily', () => {
      it('anchors the daily window to the configured time of day', () => {
        const settings = makeSettings({ windowStart: '01:50', durationHours: 2 });
        // 01:50 + 2h = 03:50, so 02:30 is inside the window the admin chose
        // (and outside the midnight window the old code assumed).
        expect(isInMaintenanceWindow(settings, new Date('2026-02-17T02:30:00Z')).active).toBe(true);
      });

      it('is inactive before the configured start time', () => {
        const settings = makeSettings({ windowStart: '01:50', durationHours: 2 });
        // 00:30 precedes today's 01:50 start; the previous occurrence
        // (Feb 16 01:50-03:50) is long over.
        expect(isInMaintenanceWindow(settings, new Date('2026-02-17T00:30:00Z')).active).toBe(false);
      });

      it('stays active after the start time on the same day', () => {
        const settings = makeSettings({ windowStart: '22:00', durationHours: 2 });
        expect(isInMaintenanceWindow(settings, new Date('2026-02-17T23:00:00Z')).active).toBe(true);
      });

      it('keeps a window that opened yesterday active past midnight', () => {
        const settings = makeSettings({ windowStart: '23:00', durationHours: 2 });
        // Feb 16 23:00 - Feb 17 01:00 — 00:30 falls in the previous day's window.
        expect(isInMaintenanceWindow(settings, new Date('2026-02-17T00:30:00Z')).active).toBe(true);
        // 01:30 is past that window's end and before tonight's 23:00 start.
        expect(isInMaintenanceWindow(settings, new Date('2026-02-17T01:30:00Z')).active).toBe(false);
      });
    });

    describe('weekly', () => {
      it('anchors the weekly window to the configured time of day', () => {
        // 2026-02-15 is a Sunday.
        const settings = makeSettings({ recurrence: 'weekly', windowStart: '03:00', durationHours: 2 });
        expect(isInMaintenanceWindow(settings, new Date('2026-02-15T04:00:00Z')).active).toBe(true);
        expect(isInMaintenanceWindow(settings, new Date('2026-02-15T01:00:00Z')).active).toBe(false);
      });

      it('keeps a Sunday-night window active into Monday', () => {
        const settings = makeSettings({ recurrence: 'weekly', windowStart: '23:00', durationHours: 3 });
        // Sunday Feb 15 23:00 - Monday Feb 16 02:00.
        expect(isInMaintenanceWindow(settings, new Date('2026-02-16T01:00:00Z')).active).toBe(true);
        expect(isInMaintenanceWindow(settings, new Date('2026-02-16T03:00:00Z')).active).toBe(false);
      });
    });

    describe('monthly', () => {
      it('anchors the monthly window to the configured time of day', () => {
        const settings = makeSettings({ recurrence: 'monthly', windowStart: '06:00', durationHours: 2 });
        expect(isInMaintenanceWindow(settings, new Date('2026-02-01T07:00:00Z')).active).toBe(true);
        expect(isInMaintenanceWindow(settings, new Date('2026-02-01T05:00:00Z')).active).toBe(false);
      });

      it('keeps a window that opened on the 1st active into the 2nd', () => {
        const settings = makeSettings({ recurrence: 'monthly', windowStart: '23:00', durationHours: 3 });
        expect(isInMaintenanceWindow(settings, new Date('2026-02-02T01:00:00Z')).active).toBe(true);
        expect(isInMaintenanceWindow(settings, new Date('2026-02-02T03:00:00Z')).active).toBe(false);
      });

      it('falls back to the previous month when the 1st has not reached the start time', () => {
        const settings = makeSettings({ recurrence: 'monthly', windowStart: '12:00', durationHours: 2 });
        // Feb 1 04:00 precedes Feb 1 12:00, so the most recent occurrence is
        // Jan 1 12:00-14:00 — long over.
        expect(isInMaintenanceWindow(settings, new Date('2026-02-01T04:00:00Z')).active).toBe(false);
      });
    });

    it('honours the configured timezone when anchoring', () => {
      // 2026-02-17T07:00:00Z is 08:00 in Europe/Warsaw (CET = UTC+1).
      const settings = makeSettings({ timezone: 'Europe/Warsaw', windowStart: '07:30', durationHours: 2 });
      expect(isInMaintenanceWindow(settings, new Date('2026-02-17T07:00:00Z')).active).toBe(true);
      // 06:00Z is 07:00 Warsaw — before the 07:30 start.
      expect(isInMaintenanceWindow(settings, new Date('2026-02-17T06:00:00Z')).active).toBe(false);
    });

    it('accepts a full ISO datetime and uses only its time component', () => {
      // A policy switched from `once` to `daily` still has a datetime stored;
      // anchor to its time of day rather than silently reverting to midnight.
      const settings = makeSettings({ windowStart: '2026-01-05T04:30:00', durationHours: 1 });
      expect(isInMaintenanceWindow(settings, new Date('2026-02-17T05:00:00Z')).active).toBe(true);
    });

    it('keeps midnight anchoring when no start time is stored', () => {
      // Pre-#4224 rows have window_start NULL — their schedule must not move.
      const settings = makeSettings({ windowStart: null, durationHours: 2 });
      expect(isInMaintenanceWindow(settings, new Date('2026-02-17T00:30:00Z')).active).toBe(true);
      expect(isInMaintenanceWindow(settings, new Date('2026-02-17T02:30:00Z')).active).toBe(false);
    });

    it('treats an empty start time as midnight', () => {
      const settings = makeSettings({ windowStart: '   ', durationHours: 2 });
      expect(isInMaintenanceWindow(settings, new Date('2026-02-17T00:30:00Z')).active).toBe(true);
    });

    it('warns and falls back to midnight for an unparseable start time', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const settings = makeSettings({ windowStart: 'not-a-time', durationHours: 2 });
      const result = isInMaintenanceWindow(settings, new Date('2026-02-17T00:30:00Z'));
      expect(result.active).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('not-a-time'));
      warnSpy.mockRestore();
    });

    it('warns and falls back to midnight for an out-of-range start time', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const settings = makeSettings({ windowStart: '25:00', durationHours: 2 });
      const result = isInMaintenanceWindow(settings, new Date('2026-02-17T00:30:00Z'));
      expect(result.active).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('25:00'));
      warnSpy.mockRestore();
    });

    // `migrateToConfigPolicies` stores `once` windows as `toISOString()`, so a
    // policy later switched to a recurring cadence can still hold a Z-suffixed
    // instant. Its digits are UTC, not wall-clock time in `settings.timezone` —
    // reading them as local would shift the window by the zone's offset with
    // nothing in the UI to show for it.
    it('refuses to read a Z-suffixed instant as a local time of day', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const settings = makeSettings({
        timezone: 'Europe/Warsaw',
        windowStart: '2026-01-05T04:30:00.000Z',
        durationHours: 2,
      });
      // 23:30Z is 00:30 Warsaw — inside the midnight fallback window, and
      // outside the 04:30-06:30 window the naive digit read would produce.
      expect(isInMaintenanceWindow(settings, new Date('2026-02-16T23:30:00Z')).active).toBe(true);
      // 04:00Z is 05:00 Warsaw — inside that bogus window, outside midnight's.
      expect(isInMaintenanceWindow(settings, new Date('2026-02-17T04:00:00Z')).active).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('2026-01-05T04:30:00.000Z'));
      warnSpy.mockRestore();
    });

    it('refuses to read a datetime with a numeric UTC offset as a local time of day', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const settings = makeSettings({
        timezone: 'Europe/Warsaw',
        windowStart: '2026-01-05T04:30:00+02:00',
        durationHours: 2,
      });
      expect(isInMaintenanceWindow(settings, new Date('2026-02-16T23:30:00Z')).active).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('+02:00'));
      warnSpy.mockRestore();
    });

    it('does not warn about windowStart for the `once` recurrence', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const settings = makeSettings({ recurrence: 'once', windowStart: 'not-a-date' });
      expect(isInMaintenanceWindow(settings, new Date('2026-02-17T00:30:00Z')).active).toBe(false);
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  // ============================================
  // Unknown recurrence
  // ============================================

  it('returns inactive for an unknown recurrence type', () => {
    const settings = makeSettings({ recurrence: 'biweekly' });
    const result = isInMaintenanceWindow(settings, new Date());
    expect(result.active).toBe(false);
  });

  // ============================================
  // Default now
  // ============================================

  it('uses Date.now() when no now parameter is passed', () => {
    // We can't predict the exact result but we can verify it returns the right shape
    const result = isInMaintenanceWindow(makeSettings());
    expect(result).toHaveProperty('active');
    expect(result).toHaveProperty('suppressAlerts');
    expect(result).toHaveProperty('suppressPatching');
    expect(result).toHaveProperty('suppressAutomations');
    expect(result).toHaveProperty('suppressScripts');
  });
});

describe('createSystemAuthContext', () => {
  it('returns an AuthContext with system scope', () => {
    const ctx = createSystemAuthContext();
    expect(ctx.scope).toBe('system');
  });

  it('has a deterministic system user ID', () => {
    const ctx = createSystemAuthContext();
    expect(ctx.user.id).toBe('00000000-0000-0000-0000-000000000000');
    expect(ctx.user.email).toBe('system@breeze.internal');
  });

  it('has null orgId and partnerId', () => {
    const ctx = createSystemAuthContext();
    expect(ctx.orgId).toBeNull();
    expect(ctx.partnerId).toBeNull();
  });

  it('has an accessibleOrgIds of null (all orgs)', () => {
    const ctx = createSystemAuthContext();
    expect(ctx.accessibleOrgIds).toBeNull();
  });

  it('canAccessOrg returns true for any org', () => {
    const ctx = createSystemAuthContext();
    expect(ctx.canAccessOrg('any-org-id')).toBe(true);
    expect(ctx.canAccessOrg('another-org')).toBe(true);
  });

  it('orgCondition returns undefined (no filter)', () => {
    const ctx = createSystemAuthContext();
    expect(ctx.orgCondition(null as any)).toBeUndefined();
  });

  it('token has expected system fields', () => {
    const ctx = createSystemAuthContext();
    expect(ctx.token!.scope).toBe('system');
    expect(ctx.token!.type).toBe('access');
    expect(ctx.token!.mfa).toBe(false);
    expect(ctx.token!.roleId).toBeNull();
  });
});

describe('retired alert-rule resolver surface', () => {
  it('does not expose public legacy alert-rule resolvers or their result type', () => {
    const source = readFileSync(new URL('./featureConfigResolver.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/export\s+(?:async\s+function|type)\s+(?:resolveAlertRulesForDevice|resolveGoverningAlertRulePolicyForDevice|GoverningAlertRulePolicy)\b/);
    expect(source).not.toContain('configPolicyAlertRules');
  });
});
