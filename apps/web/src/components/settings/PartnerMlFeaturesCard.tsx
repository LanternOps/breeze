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
 * COMPLETE block of the section it belongs to (`ml.anomalies` or
 * `ml.remediation_suggestions`) and nothing else — the API deep-merges `ml` one
 * level, so sibling blocks are preserved — and reverts on failure.
 */
type MlState = {
  anomalies: { enabled: boolean; create_alerts: boolean };
  remediation_suggestions: { enabled: boolean };
};
type Section = keyof MlState;

function initialState(value: MlFeatureSettings | undefined): MlState {
  return {
    anomalies: {
      enabled: value?.anomalies?.enabled ?? false,
      create_alerts: value?.anomalies?.create_alerts ?? false,
    },
    remediation_suggestions: {
      enabled: value?.remediation_suggestions?.enabled ?? false,
    },
  };
}

export default function PartnerMlFeaturesCard({
  value,
  onSaved,
}: {
  value: MlFeatureSettings | undefined;
  onSaved: () => void;
}) {
  const { t } = useTranslation('settings');
  const [ml, setMl] = useState<MlState>(() => initialState(value));
  const [busy, setBusy] = useState(false);

  const toggle = async <S extends Section>(section: S, key: keyof MlState[S], next: boolean) => {
    if (busy) return;
    const previous = ml;
    const block = { ...ml[section], [key]: next } as MlState[S];
    setMl({ ...ml, [section]: block });
    setBusy(true);
    try {
      await runAction({
        request: () =>
          fetchWithAuth('/orgs/partners/me', {
            method: 'PATCH',
            body: JSON.stringify({ settings: { ml: { [section]: block } } }),
          }),
        successMessage: t('partnerSettingsPage.aiFeatures.saved'),
        errorFallback: t('partnerSettingsPage.aiFeatures.saveFailed'),
        onUnauthorized: handleSessionExpired,
      });
      onSaved();
    } catch (err) {
      setMl(previous);
      if (!(err instanceof ActionError)) throw err;
    } finally {
      setBusy(false);
    }
  };

  const row = <S extends Section>(
    section: S,
    key: keyof MlState[S] & string,
    testId: string,
    label: string,
    description: string,
  ) => (
    <label className="flex items-start gap-3 rounded-md border bg-muted/30 p-3">
      <input
        type="checkbox"
        data-testid={testId}
        checked={ml[section][key] as boolean}
        disabled={busy}
        onChange={(e) => void toggle(section, key, e.target.checked)}
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
      {row('anomalies', 'enabled', 'partner-ml-anomalies-enabled',
        t('partnerSettingsPage.aiFeatures.anomalies.enabled'),
        t('partnerSettingsPage.aiFeatures.anomalies.enabledDescription'))}
      {row('anomalies', 'create_alerts', 'partner-ml-anomalies-create-alerts',
        t('partnerSettingsPage.aiFeatures.anomalies.createAlerts'),
        t('partnerSettingsPage.aiFeatures.anomalies.createAlertsDescription'))}
      <div className="pt-3">
        <h3 className="text-base font-semibold">{t('partnerSettingsPage.aiFeatures.remediation.title')}</h3>
        <p className="text-sm text-muted-foreground">{t('partnerSettingsPage.aiFeatures.remediation.description')}</p>
      </div>
      {row('remediation_suggestions', 'enabled', 'partner-ml-remediation-suggestions-enabled',
        t('partnerSettingsPage.aiFeatures.remediation.enabled'),
        t('partnerSettingsPage.aiFeatures.remediation.enabledDescription'))}
      <p className="text-xs text-muted-foreground">{t('partnerSettingsPage.aiFeatures.inheritanceNote')}</p>
    </div>
  );
}
