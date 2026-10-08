import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, handleActionError } from '../../lib/runAction';
import { navigateTo } from '@/lib/navigation';
import { loginPathWithNext } from '../../lib/authScope';

/**
 * W06 (#3900) — Settings → Ticketing → Time Tracking.
 *
 * Partner-wide and OFF by default: with the flag off the API returns
 * `{ enabled:false, suggestions: [] }` and the whole feature is invisible.
 *
 * Bounds mirror the API schema (`partnerSettingsSchema.timeTracking`) exactly —
 * minSessionSeconds 30–3600, mergeGapMinutes 0–120. They are checked here so a
 * typo is a message next to the field rather than a round-trip 400, but the
 * server remains authoritative.
 */
const MIN_SESSION_MIN = 30;
const MIN_SESSION_MAX = 3600;
const MERGE_GAP_MIN = 0;
const MERGE_GAP_MAX = 120;

const DEFAULTS = { enabled: false, minSessionSeconds: 120, mergeGapMinutes: 10 };

// #4186 — arrival suggestions. Bounds mirror SITE_RADIUS_MIN_M / SITE_RADIUS_MAX_M /
// LOCATION_DEFAULT_RADIUS_M in @breeze/shared (the server stays authoritative).
const RADIUS_MIN = 50;
const RADIUS_MAX = 1000;
const LOCATION_DEFAULTS = { enabled: false, defaultRadiusM: 150 };

const UNAUTHORIZED = () => void navigateTo(loginPathWithNext(), { replace: true });

function readBlock(settings: unknown): typeof DEFAULTS {
  const rec = (v: unknown): Record<string, unknown> =>
    v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const block = rec(rec(rec(settings).timeTracking).sessionSuggestions);
  const int = (v: unknown, fallback: number) =>
    typeof v === 'number' && Number.isInteger(v) ? v : fallback;
  return {
    // #3608: only an explicit `true` is on — and a stored `false` is a decision,
    // so it renders as off rather than as "unset". Same rule the API's
    // parseSessionSuggestionSettings applies.
    enabled: block.enabled === true,
    minSessionSeconds: int(block.minSessionSeconds, DEFAULTS.minSessionSeconds),
    mergeGapMinutes: int(block.mergeGapMinutes, DEFAULTS.mergeGapMinutes),
  };
}

function readLocationBlock(settings: unknown): typeof LOCATION_DEFAULTS {
  const rec = (v: unknown): Record<string, unknown> =>
    v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const block = rec(rec(rec(settings).timeTracking).locationSuggestions);
  const radius = block.defaultRadiusM;
  return {
    // Same rule as the API parser: only an explicit `true` is on.
    enabled: block.enabled === true,
    defaultRadiusM:
      typeof radius === 'number' && Number.isInteger(radius) && radius >= RADIUS_MIN && radius <= RADIUS_MAX
        ? radius
        : LOCATION_DEFAULTS.defaultRadiusM,
  };
}

export default function TimeTrackingSettingsCard() {
  const { t } = useTranslation('settings');
  const [enabled, setEnabled] = useState(DEFAULTS.enabled);
  const [minSession, setMinSession] = useState(String(DEFAULTS.minSessionSeconds));
  const [mergeGap, setMergeGap] = useState(String(DEFAULTS.mergeGapMinutes));
  const [locationEnabled, setLocationEnabled] = useState(LOCATION_DEFAULTS.enabled);
  const [radius, setRadius] = useState(String(LOCATION_DEFAULTS.defaultRadiusM));
  const [radiusError, setRadiusError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // A failed initial read leaves defaults in the form; Save would then PATCH
  // those defaults over the stored settings, so Save stays disabled instead.
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchWithAuth('/orgs/partners/me');
        if (res.ok) {
          const body = (await res.json()) as { data?: { settings?: unknown } };
          const block = readBlock(body.data?.settings);
          if (!cancelled) {
            setEnabled(block.enabled);
            setMinSession(String(block.minSessionSeconds));
            setMergeGap(String(block.mergeGapMinutes));
            const loc = readLocationBlock(body.data?.settings);
            setLocationEnabled(loc.enabled);
            setRadius(String(loc.defaultRadiusM));
          }
        } else if (!cancelled) {
          setLoadFailed(true);
        }
      } catch {
        if (!cancelled) setLoadFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const save = useCallback(async () => {
    if (loadFailed) return;
    const minSessionSeconds = Number(minSession);
    const mergeGapMinutes = Number(mergeGap);
    if (!Number.isInteger(minSessionSeconds) || minSessionSeconds < MIN_SESSION_MIN || minSessionSeconds > MIN_SESSION_MAX) {
      setValidationError(t('timeTrackingSettingsCard.minSessionRange', { min: MIN_SESSION_MIN, max: MIN_SESSION_MAX }));
      return;
    }
    if (!Number.isInteger(mergeGapMinutes) || mergeGapMinutes < MERGE_GAP_MIN || mergeGapMinutes > MERGE_GAP_MAX) {
      setValidationError(t('timeTrackingSettingsCard.mergeGapRange', { min: MERGE_GAP_MIN, max: MERGE_GAP_MAX }));
      return;
    }
    setValidationError(null);
    const defaultRadiusM = Number(radius);
    const radiusValid = Number.isInteger(defaultRadiusM) && defaultRadiusM >= RADIUS_MIN && defaultRadiusM <= RADIUS_MAX;
    // The radius is only editable (and only validated) while the feature is on;
    // when off we still send the stored/default value so it is never lost.
    if (locationEnabled && !radiusValid) {
      setRadiusError(t('timeTrackingSettingsCard.radiusRange', { min: RADIUS_MIN, max: RADIUS_MAX }));
      return;
    }
    setRadiusError(null);
    const locationRadius = radiusValid ? defaultRadiusM : LOCATION_DEFAULTS.defaultRadiusM;
    setSaving(true);
    try {
      await runAction({
        request: () =>
          fetchWithAuth('/orgs/partners/me', {
            method: 'PATCH',
            // The COMPLETE sessionSuggestions and locationSuggestions objects
            // (one page Save for the card). PATCH deep-merges `timeTracking`
            // one level but replaces each block wholesale, so an omitted
            // field would be destroyed.
            body: JSON.stringify({
              settings: {
                timeTracking: {
                  sessionSuggestions: { enabled, minSessionSeconds, mergeGapMinutes },
                  locationSuggestions: { enabled: locationEnabled, defaultRadiusM: locationRadius },
                },
              },
            }),
          }),
        errorFallback: t('timeTrackingSettingsCard.saveFailed'),
        successMessage: t('timeTrackingSettingsCard.saved'),
        onUnauthorized: UNAUTHORIZED,
      });
    } catch (err) {
      handleActionError(err, t('timeTrackingSettingsCard.saveFailed'));
    } finally {
      setSaving(false);
    }
  }, [enabled, minSession, mergeGap, locationEnabled, radius, loadFailed, t]);

  return (
    <div className="rounded-lg border p-4" data-testid="time-tracking-settings-card">
      <h3 className="text-sm font-medium">{t('timeTrackingSettingsCard.heading')}</h3>
      <p className="mt-1 text-sm text-muted-foreground">{t('timeTrackingSettingsCard.subheading')}</p>

      {loadFailed && (
        <p className="mt-3 text-sm text-destructive" role="alert" data-testid="time-suggestions-load-error">
          {t('timeTrackingSettingsCard.loadFailed')}
        </p>
      )}

      <label className="mt-4 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          data-testid="time-suggestions-enabled"
          checked={enabled}
          disabled={loading}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        {t('timeTrackingSettingsCard.enabledLabel')}
      </label>

      <div className="mt-3 flex flex-wrap gap-4">
        <label className="flex flex-col gap-1 text-sm">
          {t('timeTrackingSettingsCard.minSessionLabel')}
          <input
            type="number"
            data-testid="time-suggestions-min-session"
            className="w-32 rounded-md border px-2 py-1"
            value={minSession}
            min={MIN_SESSION_MIN}
            max={MIN_SESSION_MAX}
            disabled={loading}
            onChange={(e) => setMinSession(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          {t('timeTrackingSettingsCard.mergeGapLabel')}
          <input
            type="number"
            data-testid="time-suggestions-merge-gap"
            className="w-32 rounded-md border px-2 py-1"
            value={mergeGap}
            min={MERGE_GAP_MIN}
            max={MERGE_GAP_MAX}
            disabled={loading}
            onChange={(e) => setMergeGap(e.target.value)}
          />
        </label>
      </div>

      {validationError && (
        <p className="mt-2 text-sm text-destructive" data-testid="time-suggestions-error">{validationError}</p>
      )}

      <div className="mt-6 border-t pt-4">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            data-testid="location-suggestions-enabled"
            checked={locationEnabled}
            disabled={loading}
            onChange={(e) => setLocationEnabled(e.target.checked)}
          />
          {t('timeTrackingSettingsCard.locationEnabledLabel')}
        </label>
        <p className="mt-1 text-sm text-muted-foreground">{t('timeTrackingSettingsCard.locationHelp')}</p>
        {locationEnabled && (
          <label className="mt-3 flex flex-col gap-1 text-sm">
            {t('timeTrackingSettingsCard.radiusLabel')}
            <input
              type="number"
              data-testid="location-suggestions-radius"
              className="w-32 rounded-md border px-2 py-1"
              value={radius}
              min={RADIUS_MIN}
              max={RADIUS_MAX}
              disabled={loading}
              onChange={(e) => setRadius(e.target.value)}
            />
          </label>
        )}
        {radiusError && (
          <p className="mt-2 text-sm text-destructive" data-testid="location-suggestions-error">{radiusError}</p>
        )}
      </div>

      <button
        type="button"
        data-testid="time-suggestions-save"
        className="mt-4 rounded-md border px-3 py-1.5 text-sm font-medium"
        disabled={saving || loading || loadFailed}
        onClick={() => void save()}
      >
        {t('timeTrackingSettingsCard.save')}
      </button>
    </div>
  );
}
