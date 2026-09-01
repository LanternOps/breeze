import { eq } from 'drizzle-orm';
import { db } from '../db';
import { partners } from '../db/schema';

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

function asRecord(val: unknown): Record<string, unknown> {
  return val && typeof val === 'object' && !Array.isArray(val) ? (val as Record<string, unknown>) : {};
}

export function parseSessionSuggestionSettings(partnerSettings: unknown): SessionSuggestionSettings {
  const block = asRecord(asRecord(asRecord(partnerSettings).timeTracking).sessionSuggestions);
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
