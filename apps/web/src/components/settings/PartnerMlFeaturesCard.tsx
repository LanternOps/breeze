import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MlFeatureSettings } from '@breeze/shared';
import { handleActionError, runAction } from '@/lib/runAction';
import { fetchWithAuth, handleSessionExpired } from '@/stores/auth';
import AutosaveSwitch from './partnerSettings/AutosaveSwitch';
import { usePartnerSettingsSaveApi } from './partnerSettings/partnerSettingsSaveContext';

/**
 * Partner-wide defaults for the ML feature switches (`settings.ml`, read by
 * the API's mlFeatureFlags resolver). Every child org inherits these unless it
 * sets its own override on the org AI tab (OrgMlFeaturesCard).
 *
 * Autosave switches (spec §3.1): each PATCHes /orgs/partners/me immediately
 * with the COMPLETE block of the section it belongs to (`ml.anomalies` or
 * `ml.remediation_suggestions`) and nothing else — the API deep-merges `ml` one
 * level, so sibling blocks are preserved — and reverts on failure. It never
 * touches the page's unsaved drafts; its outcome goes to the header status line.
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
  /** Receives the saved ml state so the parent can update its copy without a refetch. */
  onSaved: (ml: MlFeatureSettings) => void;
}) {
  const { t } = useTranslation('settings');
  const [ml, setMl] = useState<MlState>(() => initialState(value));
  const [busy, setBusy] = useState(false);
  const { reportAutosave } = usePartnerSettingsSaveApi();

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
      onSaved({ ...ml, [section]: block });
      reportAutosave('aiFeatures', { status: 'saved', savedAt: Date.now() });
    } catch (err) {
      setMl(previous);
      reportAutosave('aiFeatures', { status: 'failed' });
      // Runs under a fire-and-forget `void toggle(...)`: never rethrow.
      handleActionError(err, t('partnerSettingsPage.aiFeatures.saveFailed'));
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
    <div className="flex items-start justify-between gap-3 rounded-md border bg-muted/30 p-3">
      <span>
        <span id={`${testId}-label`} className="block text-sm font-medium">{label}</span>
        <span id={`${testId}-description`} className="block text-xs text-muted-foreground">{description}</span>
      </span>
      <AutosaveSwitch
        checked={ml[section][key] as boolean}
        disabled={busy}
        onChange={(next) => void toggle(section, key, next)}
        labelledBy={`${testId}-label`}
        describedBy={`${testId}-description`}
        testId={testId}
      />
    </div>
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
