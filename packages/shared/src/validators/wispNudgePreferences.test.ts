import { describe, expect, it } from 'vitest';
import {
  WISP_NUDGE_PREFERENCE_DEFAULTS,
  resolveWispNudgePrefs,
  updateWispNudgePreferencesSchema,
  updateWispNudgeSettingsSchema,
  wispActivityQuerySchema,
  wispNudgePreferencesSchema,
  wispUrgentCapableSeveritiesSchema,
} from './wispNudgePreferences';
import { concernFeedbackBodySchema } from './wispConcerns';

const GRANT = '11111111-1111-4111-8111-111111111111';

describe('resolveWispNudgePrefs', () => {
  it('a missing row resolves to the defaults', () => {
    expect(resolveWispNudgePrefs(null)).toEqual(WISP_NUDGE_PREFERENCE_DEFAULTS);
    expect(resolveWispNudgePrefs(undefined)).toEqual({
      channels: { inApp: true, push: true },
      quietOverride: 'never',
      digestCadenceMinutes: 240,
      briefTimeLocal: '08:00',
      briefTimezone: null,
      proactivity: 'normal',
    });
  });

  it('garbage values resolve field by field to the defaults', () => {
    const r = resolveWispNudgePrefs({
      quietOverride: 'always' as never,
      digestCadenceMinutes: 3,
      proactivity: 'loud' as never,
      briefTimeLocal: '25:00',
      channels: { inApp: 'yes', push: false } as never,
    });
    expect(r.quietOverride).toBe('never');
    expect(r.digestCadenceMinutes).toBe(240);
    expect(r.proactivity).toBe('normal');
    expect(r.briefTimeLocal).toBe('08:00');
    expect(r.channels).toEqual({ inApp: true, push: false });
  });

  it('keeps a stored NULL brief time (brief off) and valid stored values', () => {
    const r = resolveWispNudgePrefs({ briefTimeLocal: null, briefTimezone: 'Europe/Berlin', quietOverride: 'urgent_only', proactivity: 'chatty', digestCadenceMinutes: 60 });
    expect(r.briefTimeLocal).toBeNull();
    expect(r.briefTimezone).toBe('Europe/Berlin');
    expect(r.quietOverride).toBe('urgent_only');
    expect(r.proactivity).toBe('chatty');
    expect(r.digestCadenceMinutes).toBe(60);
  });

  it('the defaults object is frozen', () => {
    expect(Object.isFrozen(WISP_NUDGE_PREFERENCE_DEFAULTS)).toBe(true);
  });
});

describe('wispNudgePreferencesSchema / updateWispNudgePreferencesSchema', () => {
  it('digestCadenceMinutes outside 15..1440 fails', () => {
    expect(wispNudgePreferencesSchema.safeParse({ ...WISP_NUDGE_PREFERENCE_DEFAULTS, digestCadenceMinutes: 10 }).success).toBe(false);
    expect(wispNudgePreferencesSchema.safeParse({ ...WISP_NUDGE_PREFERENCE_DEFAULTS, digestCadenceMinutes: 1441 }).success).toBe(false);
    expect(wispNudgePreferencesSchema.safeParse({ ...WISP_NUDGE_PREFERENCE_DEFAULTS, digestCadenceMinutes: 15 }).success).toBe(true);
  });

  it('an empty patch fails', () => {
    expect(updateWispNudgePreferencesSchema.safeParse({}).success).toBe(false);
  });

  it('a smuggled key fails (strict)', () => {
    expect(updateWispNudgePreferencesSchema.safeParse({ userId: 'x' }).success).toBe(false);
    expect(updateWispNudgePreferencesSchema.safeParse({ userId: 'x', quietOverride: 'never' }).success).toBe(false);
  });

  it('accepts a single-field patch and a null brief time', () => {
    expect(updateWispNudgePreferencesSchema.safeParse({ quietOverride: 'urgent_only' }).success).toBe(true);
    expect(updateWispNudgePreferencesSchema.safeParse({ briefTimeLocal: null }).success).toBe(true);
    expect(updateWispNudgePreferencesSchema.safeParse({ proactivity: 'quiet' }).success).toBe(true);
  });

  it('rejects a malformed brief time and an unknown time zone', () => {
    expect(updateWispNudgePreferencesSchema.safeParse({ briefTimeLocal: '8:00' }).success).toBe(false);
    expect(updateWispNudgePreferencesSchema.safeParse({ briefTimeLocal: '24:00' }).success).toBe(false);
    expect(updateWispNudgePreferencesSchema.safeParse({ briefTimezone: 'Mars/Olympus' }).success).toBe(false);
    expect(updateWispNudgePreferencesSchema.safeParse({ briefTimezone: 'America/Chicago' }).success).toBe(true);
  });

  it('channels must carry both booleans', () => {
    expect(updateWispNudgePreferencesSchema.safeParse({ channels: { inApp: true } }).success).toBe(false);
    expect(updateWispNudgePreferencesSchema.safeParse({ channels: { inApp: false, push: true } }).success).toBe(true);
  });
});

describe('partner urgent-capable settings', () => {
  it('accepts known severities and rejects unknown ones', () => {
    expect(wispUrgentCapableSeveritiesSchema.safeParse(['high']).success).toBe(true);
    expect(wispUrgentCapableSeveritiesSchema.safeParse(['critical']).success).toBe(false);
    expect(wispUrgentCapableSeveritiesSchema.safeParse(['info', 'low', 'medium', 'high', 'high']).success).toBe(false);
  });

  it('the settings body is strict', () => {
    expect(updateWispNudgeSettingsSchema.safeParse({ urgentCapableSeverities: ['high'] }).success).toBe(true);
    expect(updateWispNudgeSettingsSchema.safeParse({ urgentCapableSeverities: ['high'], partnerId: 'x' }).success).toBe(false);
  });
});

describe('wispActivityQuerySchema', () => {
  it('defaults the limit to 50 and caps it at 100', () => {
    expect(wispActivityQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(wispActivityQuerySchema.parse({ limit: '100' }).limit).toBe(100);
    expect(wispActivityQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
    expect(wispActivityQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
  });
});

describe('concernFeedbackBodySchema', () => {
  it('requires grantId and useful; note ≤ 200', () => {
    expect(concernFeedbackBodySchema.safeParse({ grantId: GRANT, useful: true }).success).toBe(true);
    expect(concernFeedbackBodySchema.safeParse({ grantId: GRANT, useful: false, note: 'too noisy' }).success).toBe(true);
    expect(concernFeedbackBodySchema.safeParse({ grantId: GRANT }).success).toBe(false);
    expect(concernFeedbackBodySchema.safeParse({ grantId: 'nope', useful: true }).success).toBe(false);
    expect(concernFeedbackBodySchema.safeParse({ grantId: GRANT, useful: true, note: 'x'.repeat(201) }).success).toBe(false);
  });
});
