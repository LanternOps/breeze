import { z } from 'zod';

export const MAX_ENROLLMENT_TTL_MINUTES = 525_600; // 365 days
export const MAX_ENROLLMENT_DEVICE_COUNT = 1000;

/** Selectable TTLs, in minutes. Mirrors the Add Device modal's option set. */
export const ENROLLMENT_TTL_OPTIONS = [60, 1440, 10080, 43200, 129600, 525600] as const;

/**
 * i18n key per option, so the Add Device modal and both settings tabs render
 * one option set from one source. Keys match the existing literals already in
 * the `devices` namespace (apps/web/src/locales/*\/devices.json) — do not mint
 * parallel ones.
 */
export const ENROLLMENT_TTL_I18N_KEYS: Record<number, string> = {
  60: 'addDeviceModal.n1Hour',
  1440: 'addDeviceModal.n24Hours',
  10080: 'addDeviceModal.n7Days',
  43200: 'addDeviceModal.n30Days',
  129600: 'addDeviceModal.n90Days',
  525600: 'addDeviceModal.n1Year',
};

/**
 * The selectable TTLs a picker may offer under `maxTtlMinutes`.
 *
 * Every TTL picker (Add Device installer tab, Add Device CLI tab, the org
 * defaults editor) MUST render this rather than `ENROLLMENT_TTL_OPTIONS`
 * directly. Offering an option above the cap is the silent-discard defect this
 * whole feature exists to remove: the write path rejects it with a 400, or the
 * read path clamps it, and either way the operator's choice is not what they
 * chose.
 *
 * A cap below every canonical option (only reachable by PATCHing the setting
 * through the API — the partner UI itself only offers canonical values) would
 * otherwise leave an empty picker, so the cap itself becomes the sole option.
 * Callers must therefore be able to label a non-canonical value: check
 * `ENROLLMENT_TTL_I18N_KEYS[minutes]` before using it.
 */
export function enrollmentTtlOptionsWithinCap(maxTtlMinutes: number): number[] {
  const allowed = ENROLLMENT_TTL_OPTIONS.filter(minutes => minutes <= maxTtlMinutes);
  return allowed.length > 0 ? [...allowed] : [maxTtlMinutes];
}

/**
 * The option list a TTL picker should actually render.
 *
 * `enrollmentTtlOptionsWithinCap` alone is not enough, because the value a
 * picker is *showing* is not always one of the canonical options:
 *
 *  - A settings editor may hold a stored value above the cap. That value is
 *    legitimate — `defaultEnrollmentTtlMinutes` is lock-exempt, and
 *    `resolveEnrollmentDefaults` clamps it at READ time, which is where
 *    clamping belongs. Rewriting it on save would destroy the operator's
 *    original intent (and silently, since these editors rebuild the whole
 *    defaults blob on any save).
 *  - An API-set default may be a non-canonical minute count under the cap
 *    (e.g. 20000). Filtering it out would leave the `<select>` matching no
 *    option, so the browser would display the FIRST option while the state —
 *    and therefore the request — still carried 20000. That display/submit
 *    divergence is the same class of defect this feature exists to remove.
 *
 * So: offerable options, plus `currentValue` when it is set and not already
 * among them, ascending. Callers must be able to label a non-canonical value —
 * check `ENROLLMENT_TTL_I18N_KEYS[minutes]` and fall back to a minutes string.
 *
 * Note this can legitimately return a value ABOVE `maxTtlMinutes` (the stored
 * over-cap case). That is correct for the settings editors, which describe
 * stored intent. A picker that MINTS something — the Add Device modal — must
 * additionally run its value through `clampTtlToOfferableOption` first, so it
 * never offers a lifetime the mint routes will reject with a 400.
 */
export function enrollmentTtlOptionsIncluding(
  maxTtlMinutes: number,
  currentValue?: number,
): number[] {
  const options = enrollmentTtlOptionsWithinCap(maxTtlMinutes);
  if (currentValue === undefined || options.includes(currentValue)) return options;
  return [...options, currentValue].sort((a, b) => a - b);
}

/**
 * Fold an OVER-cap TTL down onto the offerable set for `maxTtlMinutes`.
 *
 * Values at or below the cap are returned unchanged — including non-canonical
 * ones, which are meant to be rendered via `enrollmentTtlOptionsIncluding`
 * rather than snapped to a neighbouring option. Snapping them would silently
 * alter a value nobody asked to change; surfacing them as their own option
 * keeps display and submission identical, which is the actual requirement.
 *
 * Only for pickers that mint a credential, where an over-cap value would be
 * rejected by the server. Settings editors must NOT use this: a stored
 * over-cap default is clamped at read time and must survive a save intact.
 */
export function clampTtlToOfferableOption(ttlMinutes: number, maxTtlMinutes: number): number {
  if (ttlMinutes <= maxTtlMinutes) return ttlMinutes;
  const options = enrollmentTtlOptionsWithinCap(maxTtlMinutes);
  return options[options.length - 1]!;
}

/** Product fallbacks when neither partner nor org has expressed a preference. */
export const PRODUCT_DEFAULT_ENROLLMENT_TTL_MINUTES = 1440;
export const PRODUCT_DEFAULT_ENROLLMENT_DEVICE_COUNT = 1;

export const enrollmentDefaultsSchema = z.object({
  defaultEnrollmentTtlMinutes: z.number().int().min(1).max(MAX_ENROLLMENT_TTL_MINUTES).optional(),
  defaultEnrollmentDeviceCount: z.number().int().min(1).max(MAX_ENROLLMENT_DEVICE_COUNT).optional(),
  maxEnrollmentLinkTtlMinutes: z.number().int().min(1).max(MAX_ENROLLMENT_TTL_MINUTES).optional(),
});

export interface ResolvedEnrollmentDefaults {
  ttlMinutes: number;
  deviceCount: number;
  maxTtlMinutes: number;
}

type Defaults = Record<string, unknown>;

/**
 * Partner→org resolution for enrollment defaults.
 *
 * The two default VALUES are inherit-with-override: an org-set value wins for
 * that org, an unset org inherits the partner's. Keyed on presence (`in`), not
 * truthiness — same contract as agentVersionPins in getOrgAgentUpdateConfig
 * (apps/api/src/routes/agents/helpers.ts).
 *
 * The CAP is partner-only. A ceiling an org can raise is not a ceiling, so the
 * org's value is ignored entirely here and rejected at write time by the lock.
 *
 * `ttlMinutes` is clamped to `maxTtlMinutes` before returning. The org's
 * `defaultEnrollmentTtlMinutes` is lock-exempt (an org may set its own
 * preferred default above what the partner later lowers the cap to — the
 * write path only validates it against the global `MAX_ENROLLMENT_TTL_MINUTES`,
 * never against the partner cap), so a resolved default can legitimately land
 * above the cap. That's not a value anyone chose *for this mint request* —
 * it's a stale/lock-exempt default — so clamping here (rather than the
 * route-level reject-with-400 for an explicit ttlMinutes) is correct: a
 * ceiling a stale default can silently outrank is not a ceiling.
 */
export function resolveEnrollmentDefaults(
  partnerDefaults: Defaults,
  orgDefaults: Defaults,
): ResolvedEnrollmentDefaults {
  const pick = (field: string, fallback: number): number => {
    const raw = field in orgDefaults ? orgDefaults[field] : partnerDefaults[field];
    return typeof raw === 'number' ? raw : fallback;
  };
  const rawCap = partnerDefaults.maxEnrollmentLinkTtlMinutes;
  const maxTtlMinutes = typeof rawCap === 'number' ? rawCap : MAX_ENROLLMENT_TTL_MINUTES;
  const ttlMinutes = pick('defaultEnrollmentTtlMinutes', PRODUCT_DEFAULT_ENROLLMENT_TTL_MINUTES);
  return {
    ttlMinutes: Math.min(ttlMinutes, maxTtlMinutes),
    deviceCount: pick('defaultEnrollmentDeviceCount', PRODUCT_DEFAULT_ENROLLMENT_DEVICE_COUNT),
    maxTtlMinutes,
  };
}
