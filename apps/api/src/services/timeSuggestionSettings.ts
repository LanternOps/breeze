import { eq } from 'drizzle-orm';
import { db } from '../db';
import { partners } from '../db/schema';
import {
  readTimeTrackingSessionSuggestions,
  readTimeTrackingLocationSuggestions,
  LOCATION_DEFAULT_RADIUS_M,
  SITE_RADIUS_MIN_M,
  SITE_RADIUS_MAX_M,
} from '@breeze/shared';

/**
 * W06 (#3900) partner-wide flag for auto-suggested time entries. Lives in
 * partners.settings JSONB (sibling of the location spec's
 * timeTracking.locationSuggestions) — not a config table, so Partner-Wide
 * First adds nothing beyond "partner-only, default off".
 */
export interface SessionSuggestionSettings {
  enabled: boolean;
  minSessionSeconds: number;
  mergeGapMinutes: number;
}

export const SESSION_SUGGESTION_DEFAULTS: SessionSuggestionSettings = Object.freeze({
  enabled: false,
  minSessionSeconds: 120,
  mergeGapMinutes: 10,
});

export function parseSessionSuggestionSettings(partnerSettings: unknown): SessionSuggestionSettings {
  // Tolerant read against the shared contract (W02-API / M14): validated data
  // on the happy path, the raw sub-object plus a warning when a stored row
  // doesn't match — never a throw, and never a whole-object drop that would
  // discard the fields that ARE valid.
  const { settings: block, valid } = readTimeTrackingSessionSuggestions(partnerSettings);
  if (!valid) {
    console.warn('[timeSuggestionSettings] stored timeTracking.sessionSuggestions failed validation; falling back to per-field defaults');
  }
  const int = (v: unknown, fallback: number) =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : fallback;
  return {
    // A stored `false` is intent, not absence (#3608): only an explicit `true`
    // turns the feature on, and anything else reads as off.
    enabled: block.enabled === true,
    minSessionSeconds: int(block.minSessionSeconds, SESSION_SUGGESTION_DEFAULTS.minSessionSeconds),
    mergeGapMinutes: int(block.mergeGapMinutes, SESSION_SUGGESTION_DEFAULTS.mergeGapMinutes),
  };
}

/** Runs in the caller's DB context: a partner request can read its own partners row. */
export async function getSessionSuggestionSettings(
  partnerId: string,
): Promise<{ settings: SessionSuggestionSettings; timezone: string }> {
  const [row] = await db
    .select({ settings: partners.settings, timezone: partners.timezone })
    .from(partners)
    .where(eq(partners.id, partnerId))
    .limit(1);
  if (!row) return { settings: { ...SESSION_SUGGESTION_DEFAULTS }, timezone: 'UTC' };
  return { settings: parseSessionSuggestionSettings(row.settings), timezone: row.timezone || 'UTC' };
}

/**
 * #4186 partner-wide flag for location-aware arrival suggestions
 * (`partners.settings.timeTracking.locationSuggestions`). Off by default.
 */
export interface LocationSuggestionSettings {
  enabled: boolean;
  defaultRadiusM: number;
}

export const LOCATION_SUGGESTION_DEFAULTS: LocationSuggestionSettings = Object.freeze({
  enabled: false,
  defaultRadiusM: LOCATION_DEFAULT_RADIUS_M,
});

export function parseLocationSuggestionSettings(partnerSettings: unknown): LocationSuggestionSettings {
  const { settings: block, valid } = readTimeTrackingLocationSuggestions(partnerSettings);
  if (!valid) {
    console.warn('[timeSuggestionSettings] stored timeTracking.locationSuggestions failed validation; falling back to per-field defaults');
  }
  const radius = block.defaultRadiusM;
  return {
    // Only an explicit `true` turns the feature on (#3608).
    enabled: block.enabled === true,
    defaultRadiusM:
      typeof radius === 'number' && Number.isInteger(radius) && radius >= SITE_RADIUS_MIN_M && radius <= SITE_RADIUS_MAX_M
        ? radius
        : LOCATION_SUGGESTION_DEFAULTS.defaultRadiusM,
  };
}

/** Runs in the caller's DB context: a partner request can read its own partners row. */
export async function getLocationSuggestionSettings(partnerId: string): Promise<LocationSuggestionSettings> {
  const [row] = await db
    .select({ settings: partners.settings })
    .from(partners)
    .where(eq(partners.id, partnerId))
    .limit(1);
  if (!row) return { ...LOCATION_SUGGESTION_DEFAULTS };
  return parseLocationSuggestionSettings(row.settings);
}
