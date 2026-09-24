import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MlFeatureSettings } from '@breeze/shared';
import { ActionError, runAction } from '@/lib/runAction';
import { fetchWithAuth, handleSessionExpired } from '@/stores/auth';
import type { MlFeatureFlagName, MlFeatureFlagResolution } from '@/hooks/useMlFeatureFlags';

/**
 * Org-level override for the ML feature switches. Blank ("Inherit") means the
 * partner default applies; the control always shows what that inherited value
 * is and where it comes from (settings rule 4). Saves itself through runAction
 * — deliberately outside the page's form dirty/save cycle, like
 * OrgAiProcessingToggle — and drops the key entirely on "Inherit" so the org
 * settings JSON never carries a stale explicit copy of the partner value.
 *
 * The org PATCH replaces `settings` wholesale, so the full settings object is
 * spread and only `ml.anomalies.<key>` changes.
 */
type AnomalyKey = 'enabled' | 'create_alerts';
type Choice = 'inherit' | 'on' | 'off';

const FLAG_FOR_KEY: Record<AnomalyKey, MlFeatureFlagName> = {
  enabled: 'ml.anomalies.enabled',
  create_alerts: 'ml.anomalies.create_alerts',
};

type OrgSettingsShape = Record<string, unknown> & { ml?: MlFeatureSettings };

function choiceFor(value: boolean | undefined): Choice {
  return value === undefined ? 'inherit' : value ? 'on' : 'off';
}

export default function OrgMlFeaturesCard({
  orgId,
  settings,
  onSaved,
}: {
  orgId: string;
  settings: OrgSettingsShape;
  onSaved: () => void;
}) {
  const { t } = useTranslation('settings');
  const [anomalies, setAnomalies] = useState<MlFeatureSettings['anomalies']>(settings.ml?.anomalies ?? {});
  const [resolved, setResolved] = useState<Partial<Record<MlFeatureFlagName, MlFeatureFlagResolution>>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setAnomalies(settings.ml?.anomalies ?? {});
  }, [settings]);

  const loadResolved = useCallback(async () => {
    try {
      const res = await fetchWithAuth(`/config/ml-feature-flags?orgId=${encodeURIComponent(orgId)}`);
      if (!res.ok) return;
      const body = (await res.json()) as { mlFeatureFlags?: typeof resolved; data?: typeof resolved };
      setResolved(body.mlFeatureFlags ?? body.data ?? {});
    } catch {
      // The inherited hint is informational; the selects still work without it.
    }
  }, [orgId]);

  useEffect(() => {
    void loadResolved();
  }, [loadResolved]);

  // Scoped to this card's flags: ML_DISABLED_FLAGS is per flag, so an operator
  // disabling e.g. RCA must not read as "anomaly detection is off".
  const killSwitched = Object.values(FLAG_FOR_KEY).some((flag) => resolved[flag]?.source === 'global_kill_switch');

  const change = async (key: AnomalyKey, choice: Choice) => {
    if (busy) return;
    const previous = anomalies ?? {};
    const next: NonNullable<MlFeatureSettings['anomalies']> = { ...previous };
    if (choice === 'inherit') delete next[key];
    else next[key] = choice === 'on';
    setAnomalies(next);
    setBusy(true);
    try {
      const updatedSettings = { ...settings, ml: { ...(settings.ml ?? {}), anomalies: next } };
      await runAction({
        request: () =>
          fetchWithAuth(`/orgs/organizations/${orgId}`, {
            method: 'PATCH',
            body: JSON.stringify({ settings: updatedSettings }),
          }),
        successMessage: t('orgSettingsPage.ai.mlFeatures.saved'),
        errorFallback: t('orgSettingsPage.ai.mlFeatures.saveFailed'),
        onUnauthorized: handleSessionExpired,
      });
      onSaved();
      void loadResolved();
    } catch (err) {
      setAnomalies(previous);
      if (!(err instanceof ActionError)) throw err;
    } finally {
      setBusy(false);
    }
  };

  const inheritLabel = (key: AnomalyKey) => {
    const r = resolved[FLAG_FOR_KEY[key]];
    if (!r) return t('orgSettingsPage.ai.mlFeatures.inherit');
    const from = r.inheritedSource === 'partner_settings'
      ? t('orgSettingsPage.ai.mlFeatures.fromPartner')
      : t('orgSettingsPage.ai.mlFeatures.fromDefault');
    return r.inheritedEnabled
      ? t('orgSettingsPage.ai.mlFeatures.inheritOn', { from })
      : t('orgSettingsPage.ai.mlFeatures.inheritOff', { from });
  };

  const row = (key: AnomalyKey, testId: string, label: string, description: string) => (
    <div className="flex items-start justify-between gap-4 rounded-md border bg-muted/30 p-3">
      <span>
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-xs text-muted-foreground">{description}</span>
      </span>
      <select
        data-testid={testId}
        className="rounded-md border bg-background px-2 py-1 text-sm"
        value={choiceFor(anomalies?.[key])}
        disabled={busy || killSwitched}
        onChange={(e) => void change(key, e.target.value as Choice)}
      >
        <option value="inherit">{inheritLabel(key)}</option>
        <option value="on">{t('orgSettingsPage.ai.mlFeatures.on')}</option>
        <option value="off">{t('orgSettingsPage.ai.mlFeatures.off')}</option>
      </select>
    </div>
  );

  return (
    <div className="mt-6 space-y-3" data-testid="org-ml-features-card">
      <div>
        <h3 className="text-base font-semibold">{t('orgSettingsPage.ai.mlFeatures.title')}</h3>
        <p className="text-sm text-muted-foreground">{t('orgSettingsPage.ai.mlFeatures.description')}</p>
      </div>
      {killSwitched && (
        <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200" data-testid="org-ml-kill-switch-notice">
          {t('orgSettingsPage.ai.mlFeatures.killSwitch')}
        </p>
      )}
      {row('enabled', 'org-ml-anomalies-enabled',
        t('orgSettingsPage.ai.mlFeatures.anomaliesEnabled'),
        t('orgSettingsPage.ai.mlFeatures.anomaliesEnabledDescription'))}
      {row('create_alerts', 'org-ml-anomalies-create-alerts',
        t('orgSettingsPage.ai.mlFeatures.createAlerts'),
        t('orgSettingsPage.ai.mlFeatures.createAlertsDescription'))}
    </div>
  );
}
