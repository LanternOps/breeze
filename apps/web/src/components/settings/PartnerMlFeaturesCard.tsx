import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MlFeatureSettings } from '@breeze/shared';
import { ActionError, runAction } from '@/lib/runAction';
import { fetchWithAuth, handleSessionExpired } from '@/stores/auth';

/**
 * Partner-wide defaults for the ML feature switches (`settings.ml`, read by
 * the API's mlFeatureFlags resolver). Every child org inherits these unless it
 * sets its own override on the org AI tab (OrgMlFeaturesCard).
 *
 * Self-saving: each switch PATCHes /orgs/partners/me immediately with the
 * COMPLETE `ml.anomalies` object (the API deep-merges `ml` one level only) and
 * reverts on failure.
 */
type AnomalyKey = 'enabled' | 'create_alerts';

export default function PartnerMlFeaturesCard({
  value,
  onSaved,
}: {
  value: MlFeatureSettings | undefined;
  onSaved: () => void;
}) {
  const { t } = useTranslation('settings');
  const [anomalies, setAnomalies] = useState<{ enabled: boolean; create_alerts: boolean }>({
    enabled: value?.anomalies?.enabled ?? false,
    create_alerts: value?.anomalies?.create_alerts ?? false,
  });
  const [busy, setBusy] = useState(false);

  const toggle = async (key: AnomalyKey, next: boolean) => {
    if (busy) return;
    const previous = anomalies;
    const updated = { ...anomalies, [key]: next };
    setAnomalies(updated);
    setBusy(true);
    try {
      await runAction({
        request: () =>
          fetchWithAuth('/orgs/partners/me', {
            method: 'PATCH',
            body: JSON.stringify({ settings: { ml: { anomalies: updated } } }),
          }),
        successMessage: t('partnerSettingsPage.aiFeatures.saved'),
        errorFallback: t('partnerSettingsPage.aiFeatures.saveFailed'),
        onUnauthorized: handleSessionExpired,
      });
      onSaved();
    } catch (err) {
      setAnomalies(previous);
      if (!(err instanceof ActionError)) throw err;
    } finally {
      setBusy(false);
    }
  };

  const row = (key: AnomalyKey, testId: string, label: string, description: string) => (
    <label className="flex items-start gap-3 rounded-md border bg-muted/30 p-3">
      <input
        type="checkbox"
        data-testid={testId}
        checked={anomalies[key]}
        disabled={busy}
        onChange={(e) => void toggle(key, e.target.checked)}
        className="mt-0.5"
      />
      <span>
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-xs text-muted-foreground">{description}</span>
      </span>
    </label>
  );

  return (
    <div className="space-y-3" data-testid="partner-ml-features-card">
      <div>
        <h3 className="text-base font-semibold">{t('partnerSettingsPage.aiFeatures.anomalies.title')}</h3>
        <p className="text-sm text-muted-foreground">{t('partnerSettingsPage.aiFeatures.anomalies.description')}</p>
      </div>
      {row('enabled', 'partner-ml-anomalies-enabled',
        t('partnerSettingsPage.aiFeatures.anomalies.enabled'),
        t('partnerSettingsPage.aiFeatures.anomalies.enabledDescription'))}
      {row('create_alerts', 'partner-ml-anomalies-create-alerts',
        t('partnerSettingsPage.aiFeatures.anomalies.createAlerts'),
        t('partnerSettingsPage.aiFeatures.anomalies.createAlertsDescription'))}
      <p className="text-xs text-muted-foreground">{t('partnerSettingsPage.aiFeatures.inheritanceNote')}</p>
    </div>
  );
}
