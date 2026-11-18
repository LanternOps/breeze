import { describe, it, expect } from 'vitest';
import { maintenanceInlineSettingsSchema } from './index';

/**
 * Issue #6312: before this schema existed, every one of these payloads was
 * accepted with a 2xx and written verbatim, and only degraded (silently) at
 * evaluation time.
 */
describe('maintenanceInlineSettingsSchema', () => {
  it('applies the legacy decompose defaults for an empty payload', () => {
    const parsed = maintenanceInlineSettingsSchema.parse({});
    expect(parsed).toMatchObject({
      recurrence: 'weekly',
      durationHours: 2,
      timezone: 'UTC',
      windowStart: null,
      suppressAlerts: true,
      suppressPatching: false,
      suppressAutomations: false,
      suppressScripts: false,
      rebootIfPending: false,
      notifyBeforeMinutes: 15,
      notifyOnStart: true,
      notifyOnEnd: true,
    });
  });

  it('accepts the shape the web MaintenanceTab posts', () => {
    const parsed = maintenanceInlineSettingsSchema.parse({
      recurrence: 'weekly',
      durationHours: 4,
      timezone: 'America/New_York',
      windowStart: '02:30',
      suppressAlerts: true,
      suppressPatching: true,
      suppressAutomations: false,
      suppressScripts: false,
      rebootIfPending: false,
      notifyBeforeMinutes: 15,
      notifyOnStart: true,
      notifyOnEnd: true,
    });
    expect(parsed.windowStart).toBe('02:30');
    expect(parsed.timezone).toBe('America/New_York');
  });

  it('rejects an unknown recurrence (the evaluator would return null forever)', () => {
    expect(maintenanceInlineSettingsSchema.safeParse({ recurrence: 'fortnightly' }).success).toBe(false);
  });

  it.each([-5, 0, 73, 1.5])('rejects durationHours %s', (durationHours) => {
    expect(maintenanceInlineSettingsSchema.safeParse({ durationHours }).success).toBe(false);
  });

  it('rejects a non-IANA timezone instead of silently falling back to UTC', () => {
    expect(maintenanceInlineSettingsSchema.safeParse({ timezone: 'Nowhere/Nope' }).success).toBe(false);
  });

  it('canonicalizes a lowercase UTC', () => {
    expect(maintenanceInlineSettingsSchema.parse({ timezone: 'utc' }).timezone).toBe('UTC');
  });

  it.each(['banana', '2026-03-15T02:00Z', '+02:00', '25:00'])(
    'rejects recurring windowStart %s',
    (windowStart) => {
      expect(
        maintenanceInlineSettingsSchema.safeParse({ recurrence: 'daily', windowStart }).success
      ).toBe(false);
    }
  );

  it.each(['', null, undefined])(
    'treats an absent recurring windowStart (%s) as the midnight anchor',
    (windowStart) => {
      const parsed = maintenanceInlineSettingsSchema.parse({ recurrence: 'daily', windowStart });
      expect(parsed.windowStart).toBeNull();
    }
  );

  it.each(['2026-03-15T02:00', '2026-03-15 02:00', '2026-03-15', '2026-03-15T02:00:00Z'])(
    'accepts once windowStart %s',
    (windowStart) => {
      expect(
        maintenanceInlineSettingsSchema.safeParse({ recurrence: 'once', windowStart }).success
      ).toBe(true);
    }
  );

  it.each(['', null, '02:00', 'banana'])(
    'rejects a once window that could never open (windowStart %s)',
    (windowStart) => {
      expect(
        maintenanceInlineSettingsSchema.safeParse({ recurrence: 'once', windowStart }).success
      ).toBe(false);
    }
  );

  it('rejects an unknown key rather than persisting it as if it took effect', () => {
    expect(
      maintenanceInlineSettingsSchema.safeParse({ recurrence: 'daily', suppressEverything: true }).success
    ).toBe(false);
  });

  // #9574: the day a weekly / monthly window opens is configurable. The
  // defaults are the day the evaluator pinned before the fields existed, so a
  // payload that omits them keeps opening on Sunday / the 1st.
  it('defaults dayOfWeek to sun and dayOfMonth to 1 (the pre-#9574 fixed days)', () => {
    const parsed = maintenanceInlineSettingsSchema.parse({});
    expect(parsed.dayOfWeek).toBe('sun');
    expect(parsed.dayOfMonth).toBe(1);
  });

  it('accepts a chosen weekday and any day of the month up to the 31st', () => {
    expect(maintenanceInlineSettingsSchema.parse({ recurrence: 'weekly', dayOfWeek: 'wed' }).dayOfWeek).toBe('wed');
    expect(maintenanceInlineSettingsSchema.parse({ recurrence: 'monthly', dayOfMonth: 31 }).dayOfMonth).toBe(31);
  });

  it.each(['funday', 'Wednesday', 3, '', null])('rejects dayOfWeek %s', (dayOfWeek) => {
    expect(maintenanceInlineSettingsSchema.safeParse({ recurrence: 'weekly', dayOfWeek }).success).toBe(false);
  });

  it.each([0, 32, 1.5, '15', null])('rejects dayOfMonth %s', (dayOfMonth) => {
    expect(maintenanceInlineSettingsSchema.safeParse({ recurrence: 'monthly', dayOfMonth }).success).toBe(false);
  });

  it('rejects an out-of-range notifyBeforeMinutes', () => {
    expect(maintenanceInlineSettingsSchema.safeParse({ notifyBeforeMinutes: -1 }).success).toBe(false);
    expect(maintenanceInlineSettingsSchema.safeParse({ notifyBeforeMinutes: 1441 }).success).toBe(false);
  });
});
