import { describe, expect, it, vi } from 'vitest';
import { isInMaintenanceWindow, createSystemAuthContext } from './featureConfigResolver';

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
    expect(ctx.token.scope).toBe('system');
    expect(ctx.token.type).toBe('access');
    expect(ctx.token.mfa).toBe(false);
    expect(ctx.token.roleId).toBeNull();
  });
});
