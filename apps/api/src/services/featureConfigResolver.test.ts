import { beforeEach, describe, expect, it, vi } from 'vitest';

// ============================================
// Mocks for resolveAlertRulesForDevice's DB-backed query construction
// (2026-07-30 alert-rule ownership consolidation, task 6).
//
// The mocked query builder doesn't do real SQL filtering, so a naive mock
// that just hands back a fixed row array can't prove the join CONDITION
// changed. Instead this captures the actual condition object built by
// `resolveAlertRulesForDevice` for the configPolicyFeatureLinks join (an
// `eq`/`inArray` node produced by the real, unmocked and/eq/inArray from the
// mocked 'drizzle-orm' below) and evaluates it against each candidate row's
// simulated link featureType — the same shadowing bug this migration fixes
// would show up here as the monitoring-link row leaking through.
// ============================================
const { selectMock } = vi.hoisted(() => ({ selectMock: vi.fn() }));

vi.mock('../db', () => ({
  db: { select: (...args: unknown[]) => selectMock(...(args as [])) },
  getCurrentDbAccessContext: vi.fn(),
  runOutsideDbContext: vi.fn((fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn((fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/partnerAxisRead', () => ({
  readWithPartnerAxisVisibility: vi.fn(),
}));

vi.mock('../db/schema', () => ({
  configurationPolicies: {
    id: 'configurationPolicies.id',
    orgId: 'configurationPolicies.orgId',
    partnerId: 'configurationPolicies.partnerId',
    status: 'configurationPolicies.status',
  },
  configPolicyFeatureLinks: {
    id: 'configPolicyFeatureLinks.id',
    configPolicyId: 'configPolicyFeatureLinks.configPolicyId',
    featureType: 'configPolicyFeatureLinks.featureType',
  },
  configPolicyAssignments: {
    id: 'configPolicyAssignments.id',
    configPolicyId: 'configPolicyAssignments.configPolicyId',
    level: 'configPolicyAssignments.level',
    targetId: 'configPolicyAssignments.targetId',
    priority: 'configPolicyAssignments.priority',
    createdAt: 'configPolicyAssignments.createdAt',
    roleFilter: 'configPolicyAssignments.roleFilter',
    osFilter: 'configPolicyAssignments.osFilter',
  },
  configPolicyAlertRules: {
    id: 'configPolicyAlertRules.id',
    featureLinkId: 'configPolicyAlertRules.featureLinkId',
    sortOrder: 'configPolicyAlertRules.sortOrder',
  },
  configPolicyAutomations: {},
  configPolicyComplianceRules: {},
  configPolicyPatchSettings: {},
  configPolicyMaintenanceSettings: {},
  configPolicyBackupSettings: {},
  backupProfiles: {},
  backupConfigs: {},
  devices: {
    id: 'devices.id',
    orgId: 'devices.orgId',
    siteId: 'devices.siteId',
    deviceRole: 'devices.deviceRole',
    osType: 'devices.osType',
  },
  organizations: {
    id: 'organizations.id',
    partnerId: 'organizations.partnerId',
  },
  partners: {},
  deviceGroupMemberships: {
    deviceId: 'deviceGroupMemberships.deviceId',
    groupId: 'deviceGroupMemberships.groupId',
  },
  sites: {},
  softwarePolicies: {},
}));

vi.mock('drizzle-orm', () => {
  const sql = Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ op: 'sql', strings, values }),
    {
      param: (value: unknown) => ({ op: 'param', value }),
      join: (chunks: unknown[], separator: unknown) => ({ op: 'join', chunks, separator }),
    }
  );

  return {
    and: (...conditions: unknown[]) => ({ op: 'and', conditions }),
    eq: (column: unknown, value: unknown) => ({ op: 'eq', column, value }),
    inArray: (column: unknown, values: unknown[]) => ({ op: 'inArray', column, values }),
    asc: (value: unknown) => ({ op: 'asc', value }),
    sql,
    SQL: class SQL {},
  };
});

import {
  isInMaintenanceWindow,
  createSystemAuthContext,
  resolveAlertRulesForDevice,
  resolveGoverningAlertRulePolicyForDevice,
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

// ============================================
// resolveAlertRulesForDevice (2026-07-30 alert-rule ownership consolidation)
//
// Pre-migration, `configPolicyAlertRules` rows could hang off either an
// `alert_rule` OR a `monitoring` feature link, and the resolver's join used
// `inArray(featureType, ['alert_rule', 'monitoring'])` — so a monitoring-tab
// row could silently shadow (or be shadowed by) an alert_rule-tab row.
// Migration (2026-07-30-alert-rule-ownership-consolidation.sql) moved every
// rule off monitoring links, and the resolver now joins with
// `eq(featureType, 'alert_rule')` only. These tests fail if that join filter
// is ever loosened back to an inArray form.
// ============================================
describe('resolveAlertRulesForDevice', () => {
  type CandidateRow = {
    alertRule: { id: string; name: string };
    assignmentLevel: string;
    assignmentPriority: number;
    assignmentCreatedAt: Date;
    assignmentId: string;
    linkFeatureType: string;
  };

  // Simple thenable chain for the three loadDeviceHierarchy reads
  // (device / org / device-group memberships) — none of them depend on the
  // captured condition, so a fixed result array is enough.
  function makeHierarchyChain(result: unknown[]) {
    const chain: any = {
      from: vi.fn(() => chain),
      where: vi.fn(() => chain),
      limit: vi.fn(() => Promise.resolve(result)),
      then: (onFulfilled: any, onRejected?: any) => Promise.resolve(result).then(onFulfilled, onRejected),
    };
    return chain;
  }

  // Recursively walks the mocked condition tree built by the real (unmocked
  // logic, mocked drizzle-orm primitives) and/eq/inArray calls, looking for
  // the node that constrains configPolicyFeatureLinks.featureType. Any other
  // sub-condition (e.g. the configPolicyId equality half of the join) is
  // treated as always-true here — this harness only needs to prove which
  // featureType values the join filter itself admits.
  function featureTypeConditionAdmits(condition: unknown, featureType: string): boolean {
    if (!condition || typeof condition !== 'object') return true;
    const node = condition as { op: string; conditions?: unknown[]; column?: unknown; value?: unknown; values?: unknown[] };
    if (node.op === 'and' && Array.isArray(node.conditions)) {
      return node.conditions.every((c) => featureTypeConditionAdmits(c, featureType));
    }
    if (node.op === 'eq' && node.column === 'configPolicyFeatureLinks.featureType') {
      return node.value === featureType;
    }
    if (node.op === 'inArray' && node.column === 'configPolicyFeatureLinks.featureType') {
      return (node.values ?? []).includes(featureType);
    }
    return true;
  }

  // Simulates the assignments -> policies -> featureLinks -> alertRules join
  // chain. `.innerJoin` calls happen in a fixed order in the real code:
  // (1) configurationPolicies, (2) configPolicyFeatureLinks, (3)
  // configPolicyAlertRules — the 2nd call's condition is the one this test
  // cares about.
  function makeAlertRuleJoinChain(candidateRows: CandidateRow[]) {
    let innerJoinCount = 0;
    let featureLinkCondition: unknown;
    const chain: any = {
      from: vi.fn(() => chain),
      innerJoin: vi.fn((_table: unknown, condition: unknown) => {
        innerJoinCount += 1;
        if (innerJoinCount === 2) featureLinkCondition = condition;
        return chain;
      }),
      where: vi.fn(() => chain),
      orderBy: vi.fn(() => chain),
      then: (onFulfilled: any, onRejected?: any) => {
        const filtered = candidateRows
          .filter((row) => featureTypeConditionAdmits(featureLinkCondition, row.linkFeatureType))
          .map(({ linkFeatureType: _drop, ...rest }) => rest);
        return Promise.resolve(filtered).then(onFulfilled, onRejected);
      },
    };
    return chain;
  }

  function mockHierarchyReads() {
    selectMock
      .mockReturnValueOnce(
        makeHierarchyChain([
          { id: 'device-1', orgId: 'org-a', siteId: 'site-1', deviceRole: 'workstation', osType: 'windows' },
        ])
      ) // device
      .mockReturnValueOnce(makeHierarchyChain([{ partnerId: null }])) // org -> partnerId
      .mockReturnValueOnce(makeHierarchyChain([])); // device-group memberships
  }

  beforeEach(() => {
    vi.clearAllMocks();
    selectMock.mockReset();
  });

  it('does not return a rule reached only via a monitoring feature link (pre-migration shadow row)', async () => {
    mockHierarchyReads();
    selectMock.mockReturnValueOnce(
      makeAlertRuleJoinChain([
        {
          alertRule: { id: 'rule-monitoring', name: 'Legacy monitoring-linked rule' },
          assignmentLevel: 'device',
          assignmentPriority: 0,
          assignmentCreatedAt: new Date('2026-01-01T00:00:00Z'),
          assignmentId: 'assignment-1',
          linkFeatureType: 'monitoring',
        },
      ])
    );

    const result = await resolveAlertRulesForDevice('device-1');
    expect(result).toEqual([]);
  });

  it('returns a rule reached via an alert_rule feature link', async () => {
    mockHierarchyReads();
    selectMock.mockReturnValueOnce(
      makeAlertRuleJoinChain([
        {
          alertRule: { id: 'rule-1', name: 'CPU usage high' },
          assignmentLevel: 'device',
          assignmentPriority: 0,
          assignmentCreatedAt: new Date('2026-01-01T00:00:00Z'),
          assignmentId: 'assignment-1',
          linkFeatureType: 'alert_rule',
        },
      ])
    );

    const result = await resolveAlertRulesForDevice('device-1');
    expect(result).toEqual([{ id: 'rule-1', name: 'CPU usage high' }]);
  });

  // Regression test for the cross-feature shadowing bug this task fixes: with
  // rules living ONLY under alert_rule links (the post-migration world),
  // winning-assignment semantics must still pick the closer (device-level)
  // assignment over a farther (site-level) one — i.e. resolving within a
  // single feature type didn't accidentally break hierarchy precedence.
  it('resolves the device-level policy over a site-level policy when both are alert_rule-linked', async () => {
    mockHierarchyReads();
    selectMock.mockReturnValueOnce(
      makeAlertRuleJoinChain([
        {
          alertRule: { id: 'rule-site', name: 'Site-level rule' },
          assignmentLevel: 'site',
          assignmentPriority: 0,
          assignmentCreatedAt: new Date('2026-01-01T00:00:00Z'),
          assignmentId: 'assignment-site',
          linkFeatureType: 'alert_rule',
        },
        {
          alertRule: { id: 'rule-device', name: 'Device-level rule' },
          assignmentLevel: 'device',
          assignmentPriority: 0,
          assignmentCreatedAt: new Date('2026-01-02T00:00:00Z'),
          assignmentId: 'assignment-device',
          linkFeatureType: 'alert_rule',
        },
      ])
    );

    const result = await resolveAlertRulesForDevice('device-1');
    expect(result).toEqual([{ id: 'rule-device', name: 'Device-level rule' }]);
  });
});

// ============================================
// resolveGoverningAlertRulePolicyForDevice (#3988)
//
// This resolver deliberately cannot reuse either of its two natural
// substitutes:
//
//  - `resolveAlertRulesForDevice` inner-joins the PERSISTED
//    `config_policy_alert_rules` rows. A policy whose first rule is still an
//    unsaved draft in the editor has no feature link and no row yet, so it
//    could never appear in that join — the editor's own candidate policy
//    would always be reported as "not governing", even though it would win
//    the hierarchy the instant the tech hits save.
//  - Resolving on the `alert_rule` feature LINK alone (ignoring whether that
//    link actually holds any rule row) is equally wrong in the other
//    direction: an EMPTY link would let a closer-but-ruleless policy outrank
//    a farther policy that genuinely has persisted rules — which is not what
//    happens at runtime, where a policy contributing zero rows simply does
//    not compete.
//
// So the candidate is overlaid onto real runtime behaviour: the candidate
// always competes (its draft counts as a rule), and every OTHER policy
// competes only if it currently holds at least one persisted alert rule. Case
// 4 below ("does not let a ruleless closer-level competitor outrank the
// candidate") is the regression guard for the second bullet — without the
// `haveRules` filter on non-candidate contenders, a ruleless device-level
// policy would incorrectly outrank an organization-level candidate.
// ============================================
describe('resolveGoverningAlertRulePolicyForDevice', () => {
  type AssignedRow = {
    configPolicyId: string;
    assignmentLevel: string;
    assignmentPriority: number;
    assignmentCreatedAt: Date;
  };

  // Simple thenable chain for the three loadDeviceHierarchy reads.
  function makeHierarchyChain(result: unknown[]) {
    const chain: any = {
      from: vi.fn(() => chain),
      where: vi.fn(() => chain),
      limit: vi.fn(() => Promise.resolve(result)),
      then: (onFulfilled: any, onRejected?: any) => Promise.resolve(result).then(onFulfilled, onRejected),
    };
    return chain;
  }

  // The `assigned` query: assignments innerJoin configurationPolicies,
  // .where(...), .orderBy(level, priority, createdAt), awaited.
  function makeAssignedChain(rows: AssignedRow[]) {
    const chain: any = {
      from: vi.fn(() => chain),
      innerJoin: vi.fn(() => chain),
      where: vi.fn(() => chain),
      orderBy: vi.fn(() => chain),
      then: (onFulfilled: any, onRejected?: any) => Promise.resolve(rows).then(onFulfilled, onRejected),
    };
    return chain;
  }

  // The `policyIdsWithRules` query: configPolicyFeatureLinks innerJoin
  // configPolicyAlertRules, .where(...), awaited — no orderBy.
  function makeRulesChain(rows: { configPolicyId: string }[]) {
    const chain: any = {
      from: vi.fn(() => chain),
      innerJoin: vi.fn(() => chain),
      where: vi.fn(() => chain),
      then: (onFulfilled: any, onRejected?: any) => Promise.resolve(rows).then(onFulfilled, onRejected),
    };
    return chain;
  }

  function mockHierarchyReads() {
    selectMock
      .mockReturnValueOnce(
        makeHierarchyChain([
          { id: 'device-1', orgId: 'org-a', siteId: 'site-1', deviceRole: 'workstation', osType: 'windows' },
        ])
      ) // device
      .mockReturnValueOnce(makeHierarchyChain([{ partnerId: null }])) // org -> partnerId
      .mockReturnValueOnce(makeHierarchyChain([])); // device-group memberships
  }

  const T0 = new Date('2026-01-01T00:00:00Z');
  const T1 = new Date('2026-01-02T00:00:00Z');

  beforeEach(() => {
    vi.clearAllMocks();
    selectMock.mockReset();
  });

  it('reports governs when the candidate wins outright with no competitors', async () => {
    mockHierarchyReads();
    selectMock.mockReturnValueOnce(
      makeAssignedChain([
        { configPolicyId: 'candidate', assignmentLevel: 'device', assignmentPriority: 0, assignmentCreatedAt: T0 },
      ])
    );
    selectMock.mockReturnValueOnce(makeRulesChain([{ configPolicyId: 'candidate' }]));

    const result = await resolveGoverningAlertRulePolicyForDevice('device-1', 'candidate');
    expect(result).toEqual({ outcome: 'governs' });
  });

  it('reports outranked when a closer rules-holding policy beats the candidate', async () => {
    mockHierarchyReads();
    selectMock.mockReturnValueOnce(
      makeAssignedChain([
        { configPolicyId: 'candidate', assignmentLevel: 'organization', assignmentPriority: 0, assignmentCreatedAt: T0 },
        { configPolicyId: 'other', assignmentLevel: 'device', assignmentPriority: 0, assignmentCreatedAt: T1 },
      ])
    );
    selectMock.mockReturnValueOnce(makeRulesChain([{ configPolicyId: 'other' }]));

    const result = await resolveGoverningAlertRulePolicyForDevice('device-1', 'candidate');
    expect(result).toEqual({ outcome: 'outranked', winningPolicyId: 'other' });
  });

  it('reports unassigned when the candidate is not among the assigned policies, and never issues the rules query', async () => {
    mockHierarchyReads();
    selectMock.mockReturnValueOnce(
      makeAssignedChain([
        { configPolicyId: 'other', assignmentLevel: 'device', assignmentPriority: 0, assignmentCreatedAt: T0 },
      ])
    );

    const result = await resolveGoverningAlertRulePolicyForDevice('device-1', 'candidate');
    expect(result).toEqual({ outcome: 'unassigned' });
    // 3 hierarchy reads + 1 assigned read — the policyIdsWithRules query must
    // never fire once the candidate is absent from `assigned` (early return).
    expect(selectMock).toHaveBeenCalledTimes(4);
  });

  // THE KEY CASE — regression guard for the `haveRules` filter described in
  // the block comment above. A competing policy assigned at `device` level
  // (closer than the candidate's `organization` level) but holding ZERO
  // persisted alert rules must be filtered out of `contenders`, so the
  // candidate still wins. Without the `haveRules` filter this would (wrongly)
  // resolve to `outranked`.
  it('does not let a ruleless closer-level competitor outrank the candidate', async () => {
    mockHierarchyReads();
    selectMock.mockReturnValueOnce(
      makeAssignedChain([
        { configPolicyId: 'candidate', assignmentLevel: 'organization', assignmentPriority: 0, assignmentCreatedAt: T0 },
        { configPolicyId: 'competitor', assignmentLevel: 'device', assignmentPriority: 0, assignmentCreatedAt: T1 },
      ])
    );
    // `competitor` is assigned at device level but holds no persisted alert
    // rules — absent from the policyIdsWithRules result.
    selectMock.mockReturnValueOnce(makeRulesChain([]));

    const result = await resolveGoverningAlertRulePolicyForDevice('device-1', 'candidate');
    expect(result).toEqual({ outcome: 'governs' });
  });

  it('lets the candidate compete on its own unsaved draft when it holds no persisted rules yet', async () => {
    mockHierarchyReads();
    selectMock.mockReturnValueOnce(
      makeAssignedChain([
        { configPolicyId: 'candidate', assignmentLevel: 'device', assignmentPriority: 0, assignmentCreatedAt: T0 },
      ])
    );
    // The candidate itself has no saved alert_rule rows yet — absent here —
    // yet it is exempt from the `haveRules` requirement and still wins since
    // there is no other contender.
    selectMock.mockReturnValueOnce(makeRulesChain([]));

    const result = await resolveGoverningAlertRulePolicyForDevice('device-1', 'candidate');
    expect(result).toEqual({ outcome: 'governs' });
  });

  describe('same-level priority tiebreak', () => {
    it('outranks the candidate when the competing policy has the lower (winning) priority number', async () => {
      mockHierarchyReads();
      selectMock.mockReturnValueOnce(
        makeAssignedChain([
          { configPolicyId: 'candidate', assignmentLevel: 'site', assignmentPriority: 5, assignmentCreatedAt: T0 },
          { configPolicyId: 'other', assignmentLevel: 'site', assignmentPriority: 1, assignmentCreatedAt: T1 },
        ])
      );
      selectMock.mockReturnValueOnce(makeRulesChain([{ configPolicyId: 'other' }]));

      const result = await resolveGoverningAlertRulePolicyForDevice('device-1', 'candidate');
      expect(result).toEqual({ outcome: 'outranked', winningPolicyId: 'other' });
    });

    it('governs when the candidate instead has the lower (winning) priority number', async () => {
      mockHierarchyReads();
      selectMock.mockReturnValueOnce(
        makeAssignedChain([
          { configPolicyId: 'candidate', assignmentLevel: 'site', assignmentPriority: 1, assignmentCreatedAt: T0 },
          { configPolicyId: 'other', assignmentLevel: 'site', assignmentPriority: 5, assignmentCreatedAt: T1 },
        ])
      );
      selectMock.mockReturnValueOnce(makeRulesChain([{ configPolicyId: 'other' }]));

      const result = await resolveGoverningAlertRulePolicyForDevice('device-1', 'candidate');
      expect(result).toEqual({ outcome: 'governs' });
    });
  });

  it('reports unassigned when the device itself does not exist', async () => {
    // The device lookup resolves empty, so loadDeviceHierarchy short-circuits
    // to null before issuing the org or device-group-membership reads.
    selectMock.mockReturnValueOnce(makeHierarchyChain([]));

    const result = await resolveGoverningAlertRulePolicyForDevice('missing-device', 'candidate');
    expect(result).toEqual({ outcome: 'unassigned' });
    expect(selectMock).toHaveBeenCalledTimes(1);
  });
});
