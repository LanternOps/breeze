/**
 * Wisp nudges (W06, feature #9906; w00 "Nudges (W06)", A28, A29, A31).
 *
 * Per-user nudge preferences live in `wisp_nudge_preferences` (one row per
 * user). A missing row means "defaults" — `resolveWispNudgePrefs` is the single
 * place that says so, for API, web and mobile alike (the ticket push
 * preferences rule). The partner's "urgent-capable" severities live in
 * `wisp_partner_nudge_settings` (missing row = none).
 *
 * Each closed set mirrors a CHECK in
 * apps/api/migrations/2027-01-04-110400-wisp-nudge-preferences.sql — change both
 * together.
 */
import { z } from 'zod';
import { CONCERN_SEVERITIES } from '../types/wispConcerns';

export const WISP_QUIET_OVERRIDES = ['never', 'urgent_only'] as const;
export const WISP_PROACTIVITY_LEVELS = ['quiet', 'normal', 'chatty'] as const;
/** What a nudge is (w00 A28): one concern, the digest of digest-only concerns, or the morning brief. */
export const WISP_NUDGE_KINDS = ['concern', 'digest', 'brief'] as const;
export type WispNudgeKind = (typeof WISP_NUDGE_KINDS)[number];

export const WISP_DIGEST_CADENCE_MIN_MINUTES = 15;
export const WISP_DIGEST_CADENCE_MAX_MINUTES = 1440;
export const WISP_BRIEF_TIMEZONE_MAX = 64;
const BRIEF_TIME_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

function isIanaTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const wispNudgeChannelsSchema = z.object({ inApp: z.boolean(), push: z.boolean() });
export type WispNudgeChannels = z.infer<typeof wispNudgeChannelsSchema>;
export const wispQuietOverrideSchema = z.enum(WISP_QUIET_OVERRIDES);
export type WispQuietOverride = z.infer<typeof wispQuietOverrideSchema>;
export const wispProactivitySchema = z.enum(WISP_PROACTIVITY_LEVELS);
export type WispProactivity = z.infer<typeof wispProactivitySchema>;
/** 'HH:MM' local time of the morning brief; null = brief off. */
export const wispBriefTimeLocalSchema = z.string().regex(BRIEF_TIME_RE, 'Use HH:MM (24 h)').nullable();
/** IANA time zone; null = the user's first registered phone's zone, else UTC. */
export const wispBriefTimezoneSchema = z
  .string()
  .min(1)
  .max(WISP_BRIEF_TIMEZONE_MAX)
  .refine(isIanaTimeZone, 'Unknown time zone')
  .nullable();

export const wispNudgePreferencesSchema = z.object({
  channels: wispNudgeChannelsSchema,
  quietOverride: wispQuietOverrideSchema,
  digestCadenceMinutes: z.number().int().min(WISP_DIGEST_CADENCE_MIN_MINUTES).max(WISP_DIGEST_CADENCE_MAX_MINUTES),
  briefTimeLocal: wispBriefTimeLocalSchema,
  briefTimezone: wispBriefTimezoneSchema,
  proactivity: wispProactivitySchema,
});
export type WispNudgePreferences = z.infer<typeof wispNudgePreferencesSchema>;

/** PUT /api/v1/wisp/nudge-preferences body: any non-empty subset; unknown keys (a smuggled userId) are a 400. */
export const updateWispNudgePreferencesSchema = wispNudgePreferencesSchema
  .partial()
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'No settings provided' });
export type UpdateWispNudgePreferences = z.infer<typeof updateWispNudgePreferencesSchema>;

export const WISP_NUDGE_PREFERENCE_DEFAULTS: WispNudgePreferences = Object.freeze({
  channels: Object.freeze({ inApp: true, push: true }),
  quietOverride: 'never',
  digestCadenceMinutes: 240,
  briefTimeLocal: '08:00',
  briefTimezone: null,
  proactivity: 'normal',
}) as WispNudgePreferences;

/** Total: any input (including garbage values) resolves, field by field, to a valid preference set. */
export function resolveWispNudgePrefs(row: Partial<WispNudgePreferences> | null | undefined): WispNudgePreferences {
  const d = WISP_NUDGE_PREFERENCE_DEFAULTS;
  const ch = (row?.channels ?? {}) as Partial<Record<keyof WispNudgeChannels, unknown>>;
  const pick = <T>(schema: z.ZodType<T>, v: unknown, fallback: T): T => {
    const r = schema.safeParse(v);
    return r.success ? r.data : fallback;
  };
  return {
    channels: {
      inApp: typeof ch.inApp === 'boolean' ? ch.inApp : d.channels.inApp,
      push: typeof ch.push === 'boolean' ? ch.push : d.channels.push,
    },
    quietOverride: pick(wispQuietOverrideSchema, row?.quietOverride, d.quietOverride),
    digestCadenceMinutes: pick(wispNudgePreferencesSchema.shape.digestCadenceMinutes, row?.digestCadenceMinutes, d.digestCadenceMinutes),
    // `undefined` (no stored value) → default; a stored NULL (brief off) is kept.
    briefTimeLocal: row?.briefTimeLocal === undefined ? d.briefTimeLocal : pick(wispBriefTimeLocalSchema, row.briefTimeLocal, d.briefTimeLocal),
    briefTimezone: row?.briefTimezone === undefined ? d.briefTimezone : pick(wispBriefTimezoneSchema, row.briefTimezone, d.briefTimezone),
    proactivity: pick(wispProactivitySchema, row?.proactivity, d.proactivity),
  };
}

/** The partner's urgent-capable severities (spec §7.4 "default: none"); each at most once. */
export const wispUrgentCapableSeveritiesSchema = z
  .array(z.enum(CONCERN_SEVERITIES))
  .max(CONCERN_SEVERITIES.length)
  .refine((a) => new Set(a).size === a.length, { message: 'Each severity at most once' });

export type WispNudgeSettings = { urgentCapableSeverities: Array<(typeof CONCERN_SEVERITIES)[number]> };

/** PUT /api/v1/wisp/nudge-settings body (partner admin only). */
export const updateWispNudgeSettingsSchema = z.object({ urgentCapableSeverities: wispUrgentCapableSeveritiesSchema }).strict();
export type UpdateWispNudgeSettings = z.infer<typeof updateWispNudgeSettingsSchema>;

/** GET /api/v1/wisp/thread/:id/activity query (w00 A31). */
export const WISP_ACTIVITY_DEFAULT_LIMIT = 50;
export const WISP_ACTIVITY_MAX_LIMIT = 100;
export const wispActivityQuerySchema = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(WISP_ACTIVITY_MAX_LIMIT).default(WISP_ACTIVITY_DEFAULT_LIMIT),
});
export type WispActivityQuery = z.infer<typeof wispActivityQuerySchema>;
