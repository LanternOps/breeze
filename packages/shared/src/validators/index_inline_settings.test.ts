import { describe, it, expect } from 'vitest';
import {
  patchInlineSettingsSchema,
  policyAppRuleSchema,
  ringAutoApproveSchema,
  mergeRingAutoApproveWrite,
  eventLogInlineSettingsSchema,
  sensitiveDataInlineSettingsSchema,
  monitoringInlineSettingsSchema,
} from './index';

// ============================================
// Ring Auto-Approve (#1317)
// ============================================

describe('ringAutoApproveSchema', () => {
  it('applies fail-closed defaults (third-party fields stay ABSENT, not defaulted)', () => {
    // thirdPartyApps/thirdPartyDeferralDays deliberately have no schema
    // default: an omitted value means "writer predates the field" and the API
    // write path preserves the stored row via mergeRingAutoApproveWrite. A
    // .default(false) would make an old-shape replay indistinguishable from an
    // explicit opt-out.
    const result = ringAutoApproveSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ enabled: false, severities: [], deferralDays: 0 });
    }
  });

  it('accepts an enabled gate with severities and a deferral window', () => {
    const result = ringAutoApproveSchema.safeParse({
      enabled: true,
      severities: ['critical', 'important'],
      deferralDays: 7,
    });
    expect(result.success).toBe(true);
  });

  it('rejects enabled with no severities (must opt in to a severity set)', () => {
    const result = ringAutoApproveSchema.safeParse({ enabled: true, severities: [], deferralDays: 0 });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown severity', () => {
    const result = ringAutoApproveSchema.safeParse({ enabled: true, severities: ['catastrophic'] });
    expect(result.success).toBe(false);
  });

  it('rejects a deferralDays out of range', () => {
    expect(ringAutoApproveSchema.safeParse({ enabled: true, severities: ['low'], deferralDays: 366 }).success).toBe(false);
    expect(ringAutoApproveSchema.safeParse({ enabled: true, severities: ['low'], deferralDays: -1 }).success).toBe(false);
  });

  it('allows disabled with no severities (the default off state)', () => {
    const result = ringAutoApproveSchema.safeParse({ enabled: false, severities: [], deferralDays: 0 });
    expect(result.success).toBe(true);
  });

  it('accepts a third-party-only ring: enabled with empty severities but thirdPartyApps', () => {
    const result = ringAutoApproveSchema.safeParse({
      enabled: true, severities: [], deferralDays: 0, thirdPartyApps: true, thirdPartyDeferralDays: null,
    });
    expect(result.success).toBe(true);
  });

  it('still rejects enabled with empty severities and thirdPartyApps false', () => {
    const result = ringAutoApproveSchema.safeParse({
      enabled: true, severities: [], deferralDays: 0, thirdPartyApps: false, thirdPartyDeferralDays: null,
    });
    expect(result.success).toBe(false);
  });

  it('leaves omitted third-party fields undefined for the write path to merge', () => {
    const result = ringAutoApproveSchema.parse({ enabled: true, severities: ['critical'], deferralDays: 0 });
    expect(result.thirdPartyApps).toBeUndefined();
    expect(result.thirdPartyDeferralDays).toBeUndefined();
  });

  it('mergeRingAutoApproveWrite: absent fields carry the stored opt-in; explicit values win; create stamps defaults', () => {
    const incoming = ringAutoApproveSchema.parse({ enabled: true, severities: ['low'], deferralDays: 2 });
    // Stored explicit opt-in carried
    expect(mergeRingAutoApproveWrite(incoming, {
      enabled: true, severities: ['critical'], deferralDays: 0, thirdPartyApps: true, thirdPartyDeferralDays: 9,
    })).toEqual({ enabled: true, severities: ['low'], deferralDays: 2, thirdPartyApps: true, thirdPartyDeferralDays: 9 });
    // Legacy stored row without the field: derives from stored severities
    expect(mergeRingAutoApproveWrite(incoming, { enabled: true, severities: ['critical'] }).thirdPartyApps).toBe(true);
    expect(mergeRingAutoApproveWrite(incoming, { enabled: true, severities: [] }).thirdPartyApps).toBe(false);
    // Explicit false always wins over a stored true
    const explicitOff = ringAutoApproveSchema.parse({
      enabled: true, severities: ['low'], deferralDays: 0, thirdPartyApps: false, thirdPartyDeferralDays: null,
    });
    expect(mergeRingAutoApproveWrite(explicitOff, {
      enabled: true, severities: [], deferralDays: 0, thirdPartyApps: true, thirdPartyDeferralDays: 9,
    })).toMatchObject({ thirdPartyApps: false, thirdPartyDeferralDays: null });
    // Create (no stored row): explicit fail-closed defaults
    expect(mergeRingAutoApproveWrite(incoming, undefined)).toEqual({
      enabled: true, severities: ['low'], deferralDays: 2, thirdPartyApps: false, thirdPartyDeferralDays: null,
    });
  });

  it('rejects out-of-range thirdPartyDeferralDays', () => {
    expect(ringAutoApproveSchema.safeParse({ enabled: true, severities: ['low'], deferralDays: 0, thirdPartyApps: true, thirdPartyDeferralDays: 366 }).success).toBe(false);
    expect(ringAutoApproveSchema.safeParse({ enabled: true, severities: ['low'], deferralDays: 0, thirdPartyApps: true, thirdPartyDeferralDays: -1 }).success).toBe(false);
  });
});

// ============================================
// Patch Inline Settings
// ============================================

describe('patchInlineSettingsSchema', () => {
  it('should accept defaults', () => {
    const result = patchInlineSettingsSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sources).toEqual(['os']);
      expect(result.data.autoApprove).toBe(false);
      expect(result.data.scheduleFrequency).toBe('weekly');
      expect(result.data.scheduleTime).toBe('02:00');
      expect(result.data.scheduleDayOfWeek).toBe('sun');
      expect(result.data.scheduleDayOfMonth).toBe(1);
      expect(result.data.rebootPolicy).toBe('if_required');
    }
  });

  it('should reject invalid scheduleTime', () => {
    expect(patchInlineSettingsSchema.safeParse({ scheduleTime: '25:00' }).success).toBe(false);
  });

  it('should reject autoApprove without severities', () => {
    expect(patchInlineSettingsSchema.safeParse({ autoApprove: true, autoApproveSeverities: [] }).success).toBe(false);
  });

  it('should accept legacy source values', () => {
    const result = patchInlineSettingsSchema.safeParse({
      sources: ['microsoft', 'third_party', 'drivers'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a firmware/drivers-only selection (no provider — would approve nothing)', () => {
    const result = patchInlineSettingsSchema.safeParse({ sources: ['firmware', 'drivers'] });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('sources'))).toBe(true);
    }
  });

  it('accepts firmware/drivers when combined with a provider-backed source', () => {
    const result = patchInlineSettingsSchema.safeParse({ sources: ['os', 'drivers'] });
    expect(result.success).toBe(true);
  });
});

describe('patchInlineSettingsSchema app rules + deferral', () => {
  it('defaults autoApproveDeferralDays to 0 and apps to []', () => {
    const result = patchInlineSettingsSchema.safeParse({});
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.autoApproveDeferralDays).toBe(0);
    expect(result.data.apps).toEqual([]);
  });

  it('accepts a valid block rule and a valid pin rule', () => {
    const result = patchInlineSettingsSchema.safeParse({
      apps: [
        { source: 'third_party', packageId: 'Mozilla.Firefox', action: 'block' },
        { source: 'third_party', packageId: 'VideoLAN.VLC', displayName: 'VLC', action: 'pin', pinnedVersion: '3.0.20' },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a pin rule without pinnedVersion', () => {
    const result = patchInlineSettingsSchema.safeParse({
      apps: [{ source: 'third_party', packageId: 'VideoLAN.VLC', action: 'pin' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects duplicate (source, packageId) entries case-insensitively', () => {
    const result = patchInlineSettingsSchema.safeParse({
      apps: [
        { source: 'third_party', packageId: 'Mozilla.Firefox', action: 'block' },
        { source: 'third_party', packageId: 'mozilla.firefox', action: 'pin', pinnedVersion: '120.0' },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects negative or >60 deferral days', () => {
    expect(patchInlineSettingsSchema.safeParse({ autoApproveDeferralDays: -1 }).success).toBe(false);
    expect(patchInlineSettingsSchema.safeParse({ autoApproveDeferralDays: 61 }).success).toBe(false);
  });

  it('still rejects autoApprove without severities (existing refinement intact)', () => {
    expect(patchInlineSettingsSchema.safeParse({ autoApprove: true, autoApproveSeverities: [] }).success).toBe(false);
  });

  it('rejects duplicates across the third_party/custom bucket (same packageId, different source)', () => {
    const result = patchInlineSettingsSchema.safeParse({
      apps: [
        { source: 'third_party', packageId: 'Mozilla.Firefox', action: 'block' },
        { source: 'custom', packageId: 'mozilla.firefox', action: 'pin', pinnedVersion: '120.0' },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects apps arrays longer than 200 entries', () => {
    const apps = Array.from({ length: 201 }, (_, i) => ({
      source: 'third_party' as const,
      packageId: `Vendor.App${i}`,
      action: 'block' as const,
    }));
    expect(patchInlineSettingsSchema.safeParse({ apps }).success).toBe(false);
  });

  it('rejects non-integer autoApproveDeferralDays', () => {
    expect(patchInlineSettingsSchema.safeParse({ autoApproveDeferralDays: 2.5 }).success).toBe(false);
  });
});

describe('patchInlineSettingsSchema reboot deferral (#3207)', () => {
  it('defaults deferral off so existing policies are unchanged', () => {
    const parsed = patchInlineSettingsSchema.parse({});
    expect(parsed.rebootAllowDeferral).toBe(false);
    expect(parsed.rebootMaxDeferrals).toBe(3);
    expect(parsed.rebootDeferralMinutes).toBe(60);
  });

  it('rejects a deferral window below 5 minutes', () => {
    expect(() => patchInlineSettingsSchema.parse({ rebootDeferralMinutes: 4 })).toThrow();
  });

  it('rejects a deferral window above 1440 minutes', () => {
    expect(() => patchInlineSettingsSchema.parse({ rebootDeferralMinutes: 1441 })).toThrow();
  });

  it('rejects more than 10 deferrals', () => {
    expect(() => patchInlineSettingsSchema.parse({ rebootMaxDeferrals: 11 })).toThrow();
  });

  it('rejects a negative or non-integer deferral count', () => {
    expect(() => patchInlineSettingsSchema.parse({ rebootMaxDeferrals: -1 })).toThrow();
    expect(() => patchInlineSettingsSchema.parse({ rebootMaxDeferrals: 2.5 })).toThrow();
  });

  it('rejects deferral enabled with a zero budget — that is a UI lie, not a policy', () => {
    expect(() =>
      patchInlineSettingsSchema.parse({ rebootAllowDeferral: true, rebootMaxDeferrals: 0 }),
    ).toThrow(/rebootMaxDeferrals/);
  });

  it('allows a zero budget while deferral is disabled', () => {
    const parsed = patchInlineSettingsSchema.parse({
      rebootAllowDeferral: false,
      rebootMaxDeferrals: 0,
    });
    expect(parsed.rebootMaxDeferrals).toBe(0);
  });

  it('rejects a total deferral budget that cannot fit before the 7-day agent ceiling', () => {
    // 10 x 1440 = 14400 minutes = 10 days; handleScheduleReboot caps delay at 10080.
    expect(() =>
      patchInlineSettingsSchema.parse({
        rebootAllowDeferral: true, rebootMaxDeferrals: 10, rebootDeferralMinutes: 1440,
      }),
    ).toThrow(/10080/);
  });

  it('accepts a budget that fits inside the ceiling', () => {
    const parsed = patchInlineSettingsSchema.parse({
      rebootAllowDeferral: true, rebootMaxDeferrals: 7, rebootDeferralMinutes: 1440,
    });
    expect(parsed.rebootAllowDeferral).toBe(true);
    expect(parsed.rebootMaxDeferrals).toBe(7);
  });
});

describe('policyAppRuleSchema source enum', () => {
  it('accepts third_party and custom sources', () => {
    expect(policyAppRuleSchema.safeParse({ source: 'third_party', packageId: 'Mozilla.Firefox', action: 'block' }).success).toBe(true);
    expect(policyAppRuleSchema.safeParse({ source: 'custom', packageId: 'Internal.Tool', action: 'block' }).success).toBe(true);
  });

  it('rejects sources outside the third-party bucket enum', () => {
    expect(policyAppRuleSchema.safeParse({ source: 'winget', packageId: 'Mozilla.Firefox', action: 'block' }).success).toBe(false);
    expect(policyAppRuleSchema.safeParse({ source: 'Third_Party', packageId: 'Mozilla.Firefox', action: 'block' }).success).toBe(false);
    expect(policyAppRuleSchema.safeParse({ source: '', packageId: 'Mozilla.Firefox', action: 'block' }).success).toBe(false);
  });
});

// ============================================
// Event Log Inline Settings
// ============================================

describe('eventLogInlineSettingsSchema', () => {
  it('should accept defaults', () => {
    const result = eventLogInlineSettingsSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.retentionDays).toBe(30);
      expect(result.data.maxEventsPerCycle).toBe(100);
      expect(result.data.minimumLevel).toBe('info');
      // 15m default (was 5m) — issue #2390 subprocess-churn backoff.
      expect(result.data.collectionIntervalMinutes).toBe(15);
      expect(result.data.rateLimitPerHour).toBe(12000);
      // The dead enableFullTextSearch / enableCorrelation toggles were removed (#1323).
      expect('enableFullTextSearch' in result.data).toBe(false);
      expect('enableCorrelation' in result.data).toBe(false);
    }
  });

  it('strips removed enableFullTextSearch / enableCorrelation toggles (#1323)', () => {
    // Back-compat: clients/rows that still send the old flags should parse without error,
    // and the parsed result must not surface them.
    const result = eventLogInlineSettingsSchema.safeParse({
      enableFullTextSearch: false,
      enableCorrelation: false,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect('enableFullTextSearch' in result.data).toBe(false);
      expect('enableCorrelation' in result.data).toBe(false);
    }
  });

  it('should reject retentionDays below 7', () => {
    expect(eventLogInlineSettingsSchema.safeParse({ retentionDays: 6 }).success).toBe(false);
  });

  it('should reject retentionDays above 365', () => {
    expect(eventLogInlineSettingsSchema.safeParse({ retentionDays: 366 }).success).toBe(false);
  });

  it('should accept all collectCategories', () => {
    const result = eventLogInlineSettingsSchema.safeParse({
      collectCategories: ['security', 'hardware', 'application', 'system'],
    });
    expect(result.success).toBe(true);
  });

  it('should reject empty collectCategories', () => {
    const result = eventLogInlineSettingsSchema.safeParse({
      collectCategories: [],
    });
    expect(result.success).toBe(false);
  });

  it('should accept all minimumLevel values', () => {
    const levels = ['info', 'warning', 'error', 'critical'] as const;
    for (const level of levels) {
      expect(eventLogInlineSettingsSchema.safeParse({ minimumLevel: level }).success).toBe(true);
    }
  });
});

// ============================================
// Sensitive Data Inline Settings
// ============================================

describe('sensitiveDataInlineSettingsSchema', () => {
  it('should accept defaults', () => {
    const result = sensitiveDataInlineSettingsSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.detectionClasses).toEqual(['credential']);
      expect(result.data.workers).toBe(4);
      expect(result.data.timeoutSeconds).toBe(300);
      expect(result.data.scheduleType).toBe('manual');
    }
  });

  it('should accept all detection classes', () => {
    const result = sensitiveDataInlineSettingsSchema.safeParse({
      detectionClasses: ['credential', 'pci', 'phi', 'pii', 'financial'],
    });
    expect(result.success).toBe(true);
  });

  it('should reject empty detectionClasses', () => {
    const result = sensitiveDataInlineSettingsSchema.safeParse({
      detectionClasses: [],
    });
    expect(result.success).toBe(false);
  });

  it('should accept all scheduleTypes', () => {
    const types = ['manual', 'interval', 'cron'] as const;
    for (const type of types) {
      expect(sensitiveDataInlineSettingsSchema.safeParse({ scheduleType: type }).success).toBe(true);
    }
  });

  it('should reject workers below 1', () => {
    expect(sensitiveDataInlineSettingsSchema.safeParse({ workers: 0 }).success).toBe(false);
  });

  it('should reject workers above 32', () => {
    expect(sensitiveDataInlineSettingsSchema.safeParse({ workers: 33 }).success).toBe(false);
  });

  it('should reject timeoutSeconds below 5', () => {
    expect(sensitiveDataInlineSettingsSchema.safeParse({ timeoutSeconds: 4 }).success).toBe(false);
  });

  it('should reject timeoutSeconds above 1800', () => {
    expect(sensitiveDataInlineSettingsSchema.safeParse({ timeoutSeconds: 1801 }).success).toBe(false);
  });

  it('should reject maxFileSizeBytes below 1024', () => {
    expect(sensitiveDataInlineSettingsSchema.safeParse({ maxFileSizeBytes: 1023 }).success).toBe(false);
  });

  it('should reject maxFileSizeBytes above 1073741824', () => {
    expect(sensitiveDataInlineSettingsSchema.safeParse({ maxFileSizeBytes: 1073741825 }).success).toBe(false);
  });
});

// ============================================
// Monitoring Inline Settings
// ============================================

describe('monitoringInlineSettingsSchema', () => {
  it('should accept defaults', () => {
    const result = monitoringInlineSettingsSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.checkIntervalSeconds).toBe(60);
      expect(result.data.watches).toEqual([]);
      expect(result.data.eventLogAlerts).toEqual([]);
      expect(result.data.alertRules).toEqual([]);
    }
  });

  it('should accept watch entry', () => {
    const result = monitoringInlineSettingsSchema.safeParse({
      watches: [
        {
          watchType: 'service',
          name: 'wuauserv',
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('should accept process watch with thresholds', () => {
    const result = monitoringInlineSettingsSchema.safeParse({
      watches: [
        {
          watchType: 'process',
          name: 'nginx',
          cpuThresholdPercent: 80,
          memoryThresholdMb: 512,
          autoRestart: true,
          maxRestartAttempts: 5,
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  // #3491/#3492: a saved watch loads back from the DB with nulls in the three
  // nullable columns, and the editor posts them straight back. Rejecting null
  // made an existing policy impossible to re-save once any watch had an unset
  // field — the reported error named exactly these three paths.
  it('should accept a saved watch round-tripped with null optional fields', () => {
    const result = monitoringInlineSettingsSchema.safeParse({
      watches: [
        {
          watchType: 'service',
          name: 'wuauserv',
          displayName: null,
          cpuThresholdPercent: null,
          memoryThresholdMb: null,
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      // Preserved as null rather than coerced: the write path stores `?? null`
      // and the agent delivery check is `!= null`, so both spellings behave
      // identically downstream.
      const watch = result.data.watches[0];
      expect(watch?.displayName).toBeNull();
      expect(watch?.cpuThresholdPercent).toBeNull();
      expect(watch?.memoryThresholdMb).toBeNull();
    }
  });

  // Covers all three widened fields, not just one: nullable must not become
  // "accepts anything". Type and range checks have to survive the change.
  it.each([
    ['displayName wrong type', { displayName: 42 }],
    ['displayName too long', { displayName: 'x'.repeat(256) }],
    ['cpuThresholdPercent wrong type', { cpuThresholdPercent: 'high' }],
    ['cpuThresholdPercent above max', { cpuThresholdPercent: 101 }],
    ['cpuThresholdPercent below min', { cpuThresholdPercent: -1 }],
    ['memoryThresholdMb wrong type', { memoryThresholdMb: 'lots' }],
    ['memoryThresholdMb below min', { memoryThresholdMb: -1 }],
  ])('still rejects %s after the nullable widening', (_label, patch) => {
    expect(
      monitoringInlineSettingsSchema.safeParse({
        watches: [{ watchType: 'process', name: 'nginx', ...patch }],
      }).success
    ).toBe(false);
  });

  it('should reject checkIntervalSeconds below 10', () => {
    expect(
      monitoringInlineSettingsSchema.safeParse({ checkIntervalSeconds: 9 }).success
    ).toBe(false);
  });

  it('should reject checkIntervalSeconds above 3600', () => {
    expect(
      monitoringInlineSettingsSchema.safeParse({ checkIntervalSeconds: 3601 }).success
    ).toBe(false);
  });

  it('should reject watches over 200', () => {
    const watches = Array.from({ length: 201 }, (_, i) => ({
      watchType: 'service' as const,
      name: `svc${i}`,
    }));
    expect(
      monitoringInlineSettingsSchema.safeParse({ watches }).success
    ).toBe(false);
  });

  it('should reject non-empty eventLogAlerts (moved to the Alerts feature)', () => {
    const result = monitoringInlineSettingsSchema.safeParse({
      eventLogAlerts: [
        {
          name: 'Security Alert',
          category: 'security',
          level: 'critical',
        },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(JSON.stringify(result.error.issues)).toContain('Alerts feature');
  });

  // Pre-consolidation this exercised a 50-item cap; now any non-empty
  // eventLogAlerts is write-blocked (see write-barrier tests above), so a
  // large payload is rejected for that reason rather than a size limit.
  it('should reject a large eventLogAlerts payload (write-blocked, not size-limited)', () => {
    const alerts = Array.from({ length: 51 }, (_, i) => ({
      name: `alert${i}`,
      category: 'security' as const,
      level: 'error' as const,
    }));
    expect(
      monitoringInlineSettingsSchema.safeParse({ eventLogAlerts: alerts }).success
    ).toBe(false);
  });

  it('should reject non-empty alertRules (moved to the Alerts feature)', () => {
    const result = monitoringInlineSettingsSchema.safeParse({
      alertRules: [
        {
          name: 'CPU Alert',
          conditions: [{ type: 'metric', metric: 'cpu', operator: 'gt', value: 90 }],
        },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(JSON.stringify(result.error.issues)).toContain('Alerts feature');
  });

  // Pre-consolidation these exercised shape/size validation on individual
  // rule entries; now any non-empty alertRules is write-blocked outright
  // (see write-barrier tests above), so these payloads are rejected for
  // that reason rather than the entry-level rules they used to test.
  it('should reject a non-empty alertRules payload regardless of entry shape', () => {
    const result = monitoringInlineSettingsSchema.safeParse({
      alertRules: [{ name: 'Test', conditions: [] }],
    });
    expect(result.success).toBe(false);
  });

  it('should reject a large alertRules payload (write-blocked, not size-limited)', () => {
    const rules = Array.from({ length: 101 }, (_, i) => ({
      name: `rule${i}`,
      conditions: [{ type: 'metric' as const }],
    }));
    expect(
      monitoringInlineSettingsSchema.safeParse({ alertRules: rules }).success
    ).toBe(false);
  });
});
