import { describe, it, expect } from 'vitest';
import * as validators from './index';
import {
  patchInlineSettingsSchema,
  policyAppRuleSchema,
  ringAutoApproveSchema,
  ringAppRulesSchema,
  canonicalAppRuleKey,
  mergeRingAutoApproveWrite,
  eventLogInlineSettingsSchema,
  sensitiveDataInlineSettingsSchema,
  deviceLifecycleInlineSettingsSchema,
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
    })).toEqual({ enabled: true, severities: ['low'], deferralDays: 2, thirdPartyApps: true, thirdPartyDeferralDays: 9, autoApproveUnrated: false });
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
      enabled: true, severities: ['low'], deferralDays: 2, thirdPartyApps: false, thirdPartyDeferralDays: null, autoApproveUnrated: false,
    });
  });

  it('rejects out-of-range thirdPartyDeferralDays', () => {
    expect(ringAutoApproveSchema.safeParse({ enabled: true, severities: ['low'], deferralDays: 0, thirdPartyApps: true, thirdPartyDeferralDays: 366 }).success).toBe(false);
    expect(ringAutoApproveSchema.safeParse({ enabled: true, severities: ['low'], deferralDays: 0, thirdPartyApps: true, thirdPartyDeferralDays: -1 }).success).toBe(false);
  });

  it('accepts autoApproveUnrated as an optional boolean, absent by default', () => {
    const result = ringAutoApproveSchema.safeParse({ enabled: true, severities: ['critical'], deferralDays: 0 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.autoApproveUnrated).toBeUndefined();
    }
  });

  it('accepts an explicit autoApproveUnrated: true alongside severities', () => {
    const result = ringAutoApproveSchema.safeParse({
      enabled: true, severities: ['critical'], deferralDays: 0, autoApproveUnrated: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.autoApproveUnrated).toBe(true);
    }
  });

  it('mergeRingAutoApproveWrite: absent autoApproveUnrated carries the stored value; explicit value wins; create defaults to false', () => {
    const incoming = ringAutoApproveSchema.parse({ enabled: true, severities: ['low'], deferralDays: 2 });
    expect(mergeRingAutoApproveWrite(incoming, {
      enabled: true, severities: ['critical'], deferralDays: 0, autoApproveUnrated: true,
    }).autoApproveUnrated).toBe(true);

    const explicitOff = ringAutoApproveSchema.parse({
      enabled: true, severities: ['low'], deferralDays: 0, autoApproveUnrated: false,
    });
    expect(mergeRingAutoApproveWrite(explicitOff, {
      enabled: true, severities: [], deferralDays: 0, autoApproveUnrated: true,
    }).autoApproveUnrated).toBe(false);

    expect(mergeRingAutoApproveWrite(incoming, undefined).autoApproveUnrated).toBe(false);
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

describe('patchInlineSettingsSchema offlineBehavior (#5128 W3)', () => {
  it("defaults to 'queue' so an offline device waits instead of being skipped", () => {
    const result = patchInlineSettingsSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.offlineBehavior).toBe('queue');
  });

  it("accepts an explicit 'skip' (the pre-#5128 behaviour)", () => {
    const result = patchInlineSettingsSchema.safeParse({ offlineBehavior: 'skip' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.offlineBehavior).toBe('skip');
  });

  it('rejects any other value — the column carries a matching CHECK constraint', () => {
    expect(patchInlineSettingsSchema.safeParse({ offlineBehavior: 'defer' }).success).toBe(false);
    expect(patchInlineSettingsSchema.safeParse({ offlineBehavior: '' }).success).toBe(false);
    expect(patchInlineSettingsSchema.safeParse({ offlineBehavior: null }).success).toBe(false);
  });
});

describe('patchInlineSettingsSchema retired policy-level approval keys (#8188)', () => {
  // Auto-approval and per-app block/pin rules live on the Update Ring
  // (patch_policies.auto_approve / app_rules). The policy schema no longer
  // defines them, so zod strips them: a stale client's write is ignored rather
  // than validated, defaulted or stored.
  const RETIRED = ['apps', 'autoApprove', 'autoApproveSeverities', 'autoApproveDeferralDays'] as const;

  it('does not default any retired key', () => {
    const parsed = patchInlineSettingsSchema.parse({});
    for (const key of RETIRED) expect(parsed).not.toHaveProperty(key);
  });

  it('strips valid retired keys from a payload', () => {
    const parsed = patchInlineSettingsSchema.parse({
      sources: ['os'],
      autoApprove: true,
      autoApproveSeverities: ['critical'],
      autoApproveDeferralDays: 7,
      apps: [{ source: 'third_party', packageId: 'Mozilla.Firefox', action: 'block' }],
    });
    for (const key of RETIRED) expect(parsed).not.toHaveProperty(key);
    expect(parsed.sources).toEqual(['os']);
  });

  it('no longer rejects shapes only the retired keys made invalid (they are stripped, not checked)', () => {
    for (const payload of [
      { autoApprove: true, autoApproveSeverities: [] },
      { autoApproveDeferralDays: 61 },
      { apps: [{ source: 'third_party', packageId: 'VideoLAN.VLC', action: 'pin' }] },
      {
        apps: [
          { source: 'third_party', packageId: 'Mozilla.Firefox', action: 'block' },
          { source: 'custom', packageId: 'mozilla.firefox', action: 'block' },
        ],
      },
    ]) {
      const result = patchInlineSettingsSchema.safeParse(payload);
      expect(result.success).toBe(true);
      if (result.success) for (const key of RETIRED) expect(result.data).not.toHaveProperty(key);
    }
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
      rebootAllowDeferral: true, rebootMaxDeferrals: 6, rebootDeferralMinutes: 1440,
    });
    expect(parsed.rebootAllowDeferral).toBe(true);
    expect(parsed.rebootMaxDeferrals).toBe(6);
  });

  // The ceiling bounds the WHOLE horizon the API puts on the wire —
  // computeRebootDeadline returns delay + maxDeferrals x deferralMinutes — so
  // the warning delay has to be inside the sum, not excluded from it.
  it('counts rebootDelayMinutes toward the ceiling, not just the deferral product', () => {
    expect(() =>
      patchInlineSettingsSchema.parse({
        rebootDelayMinutes: 1440,
        rebootAllowDeferral: true, rebootMaxDeferrals: 7, rebootDeferralMinutes: 1440,
      }),
    ).toThrow(/10080/);
  });

  it('accepts a total that lands exactly on the ceiling and rejects one minute past it', () => {
    expect(() =>
      patchInlineSettingsSchema.parse({
        rebootDelayMinutes: 80,
        rebootAllowDeferral: true, rebootMaxDeferrals: 10, rebootDeferralMinutes: 1000,
      }),
    ).not.toThrow();
    expect(() =>
      patchInlineSettingsSchema.parse({
        rebootDelayMinutes: 81,
        rebootAllowDeferral: true, rebootMaxDeferrals: 10, rebootDeferralMinutes: 1000,
      }),
    ).toThrow(/10080/);
  });

  it('leaves a long warning delay alone while deferral is off', () => {
    // The ceiling is about the deferral horizon; without deferral the delay is
    // bounded by its own 1-1440 range and nothing else.
    const parsed = patchInlineSettingsSchema.parse({
      rebootDelayMinutes: 1440, rebootAllowDeferral: false, rebootMaxDeferrals: 10,
      rebootDeferralMinutes: 1440,
    });
    expect(parsed.rebootDelayMinutes).toBe(1440);
  });
});

describe('patchInlineSettingsSchema restart-prompt text (#8030)', () => {
  it('defaults every prompt field to null so existing policies keep the built-in text', () => {
    const parsed = patchInlineSettingsSchema.parse({});
    expect(parsed.rebootPromptTitle).toBeNull();
    expect(parsed.rebootPromptBody).toBeNull();
    expect(parsed.rebootPromptButton).toBeNull();
  });

  it('canonicalizes blank, whitespace-only, null and absent to the same null', () => {
    for (const value of ['', '   ', null, undefined]) {
      const parsed = patchInlineSettingsSchema.parse({
        rebootPromptTitle: value,
        rebootPromptBody: value,
        rebootPromptButton: value,
      });
      expect(parsed.rebootPromptTitle).toBeNull();
      expect(parsed.rebootPromptBody).toBeNull();
      expect(parsed.rebootPromptButton).toBeNull();
    }
  });

  it('trims and keeps custom text, including the countdown placeholder and newlines in the body', () => {
    const parsed = patchInlineSettingsSchema.parse({
      rebootPromptTitle: '  Neustart geplant ',
      rebootPromptBody: 'Neustart in {{countdown}}.\nBitte speichern Sie Ihre Arbeit.',
      rebootPromptButton: 'Jetzt neu starten',
    });
    expect(parsed.rebootPromptTitle).toBe('Neustart geplant');
    expect(parsed.rebootPromptBody).toBe('Neustart in {{countdown}}.\nBitte speichern Sie Ihre Arbeit.');
    expect(parsed.rebootPromptButton).toBe('Jetzt neu starten');
  });

  it('enforces the length limits', () => {
    expect(() => patchInlineSettingsSchema.parse({ rebootPromptTitle: 'a'.repeat(100) })).not.toThrow();
    expect(() => patchInlineSettingsSchema.parse({ rebootPromptTitle: 'a'.repeat(101) })).toThrow();
    expect(() => patchInlineSettingsSchema.parse({ rebootPromptBody: 'a'.repeat(500) })).not.toThrow();
    expect(() => patchInlineSettingsSchema.parse({ rebootPromptBody: 'a'.repeat(501) })).toThrow();
    expect(() => patchInlineSettingsSchema.parse({ rebootPromptButton: 'a'.repeat(40) })).not.toThrow();
    expect(() => patchInlineSettingsSchema.parse({ rebootPromptButton: 'a'.repeat(41) })).toThrow();
  });

  it('rejects markup characters in every field', () => {
    for (const field of ['rebootPromptTitle', 'rebootPromptBody', 'rebootPromptButton']) {
      expect(() => patchInlineSettingsSchema.parse({ [field]: '<b>Restart</b>' })).toThrow();
      expect(() => patchInlineSettingsSchema.parse({ [field]: 'a > b' })).toThrow();
    }
  });

  it('rejects control characters, allowing newline and tab only in the body', () => {
    expect(() => patchInlineSettingsSchema.parse({ rebootPromptTitle: 'a\nb' })).toThrow();
    expect(() => patchInlineSettingsSchema.parse({ rebootPromptButton: 'a\tb' })).toThrow();
    expect(() => patchInlineSettingsSchema.parse({ rebootPromptBody: 'a\u0000b' })).toThrow();
    expect(() => patchInlineSettingsSchema.parse({ rebootPromptBody: 'a\u001b[31mb' })).toThrow();
    expect(() => patchInlineSettingsSchema.parse({ rebootPromptBody: 'a\tb\nc' })).not.toThrow();
  });

  it('rejects placeholders other than {{countdown}} so a typo cannot reach a user verbatim', () => {
    expect(() => patchInlineSettingsSchema.parse({ rebootPromptBody: 'in {{countdwon}}' })).toThrow();
    expect(() => patchInlineSettingsSchema.parse({ rebootPromptTitle: 'in {{ countdown }}' })).toThrow();
    expect(() => patchInlineSettingsSchema.parse({ rebootPromptButton: 'Now {{countdown}}' })).not.toThrow();
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
// device_lifecycle (#2787 item 4) — purge removed devices after N days
// ============================================

describe('deviceLifecycleInlineSettingsSchema', () => {
  it('accepts an absent value — the policy exists but never purges', () => {
    const result = deviceLifecycleInlineSettingsSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.purgeRemovedAfterDays).toBeUndefined();
  });

  it('accepts an explicit null — "off", distinct from a stale stored number', () => {
    const result = deviceLifecycleInlineSettingsSchema.safeParse({ purgeRemovedAfterDays: null });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.purgeRemovedAfterDays).toBeNull();
  });

  it('accepts a retention window inside the supported range', () => {
    expect(deviceLifecycleInlineSettingsSchema.safeParse({ purgeRemovedAfterDays: 30 }).success).toBe(true);
    expect(deviceLifecycleInlineSettingsSchema.safeParse({ purgeRemovedAfterDays: 1 }).success).toBe(true);
    expect(deviceLifecycleInlineSettingsSchema.safeParse({ purgeRemovedAfterDays: 3650 }).success).toBe(true);
  });

  it('rejects 0 and negatives — this setting deletes data permanently, so "purge immediately" must not be expressible by accident', () => {
    expect(deviceLifecycleInlineSettingsSchema.safeParse({ purgeRemovedAfterDays: 0 }).success).toBe(false);
    expect(deviceLifecycleInlineSettingsSchema.safeParse({ purgeRemovedAfterDays: -1 }).success).toBe(false);
  });

  it('rejects a window past the 10-year ceiling', () => {
    expect(deviceLifecycleInlineSettingsSchema.safeParse({ purgeRemovedAfterDays: 3651 }).success).toBe(false);
    expect(deviceLifecycleInlineSettingsSchema.safeParse({ purgeRemovedAfterDays: 4000 }).success).toBe(false);
  });

  it('rejects non-integers and non-numbers rather than truncating them', () => {
    expect(deviceLifecycleInlineSettingsSchema.safeParse({ purgeRemovedAfterDays: 30.5 }).success).toBe(false);
    expect(deviceLifecycleInlineSettingsSchema.safeParse({ purgeRemovedAfterDays: '30' }).success).toBe(false);
  });

  it('rejects unknown keys instead of persisting-and-echoing a setting that never takes effect', () => {
    expect(
      deviceLifecycleInlineSettingsSchema.safeParse({ purgeRemovedAfterDays: 30, purgeEverything: true }).success,
    ).toBe(false);
  });
});

describe('retired inline settings validators', () => {
  it.each(['alertRuleInlineSettingsSchema', 'monitoringInlineSettingsSchema'])('does not export %s', (name) => {
    expect(validators).not.toHaveProperty(name);
  });
});

// ============================================
// Ring App Rules (#8184 W01)
// ============================================

describe('ringAppRulesSchema', () => {
  it('accepts block and pin rules', () => {
    const r = ringAppRulesSchema.safeParse([
      { source: 'third_party', packageId: 'Mozilla.Firefox', action: 'block' },
      { source: 'custom', packageId: 'acme.tool', action: 'pin', pinnedVersion: '1.2.3' },
    ]);
    expect(r.success).toBe(true);
  });

  it('accepts an empty list', () => {
    expect(ringAppRulesSchema.safeParse([]).success).toBe(true);
  });

  it('rejects a pin without a version', () => {
    expect(ringAppRulesSchema.safeParse([{ source: 'third_party', packageId: 'x', action: 'pin' }]).success).toBe(false);
  });

  it('rejects duplicates by canonical key (custom/third_party bucket, case-insensitive id)', () => {
    const r = ringAppRulesSchema.safeParse([
      { source: 'third_party', packageId: 'Mozilla.Firefox', action: 'block' },
      { source: 'custom', packageId: 'mozilla.firefox', action: 'block' },
    ]);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.path).toEqual([1, 'packageId']);
  });

  it('accepts 200 rules and rejects 201', () => {
    const rules = (n: number) => Array.from({ length: n }, (_, i) => ({ source: 'third_party', packageId: `p${i}`, action: 'block' }));
    expect(ringAppRulesSchema.safeParse(rules(200)).success).toBe(true);
    expect(ringAppRulesSchema.safeParse(rules(201)).success).toBe(false);
  });

  it('rejects a non-array', () => {
    expect(ringAppRulesSchema.safeParse({ source: 'third_party', packageId: 'x', action: 'block' }).success).toBe(false);
  });
});

describe('canonicalAppRuleKey', () => {
  it('collapses custom into third_party and lowercases', () => {
    expect(canonicalAppRuleKey('custom', 'A.B')).toBe('third_party|a.b');
    expect(canonicalAppRuleKey('third_party', 'A.B')).toBe('third_party|a.b');
  });

  it('keeps other sources in their own bucket', () => {
    expect(canonicalAppRuleKey('microsoft', 'KB123')).toBe('microsoft|kb123');
  });
});
