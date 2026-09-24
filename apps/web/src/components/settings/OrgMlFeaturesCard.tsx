import { useCallback, useEffect, useState } from 'react';
import type { TFunction } from 'i18next';
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
 * spread and only `ml.<section>.<key>` changes. The kill switch is reported
 * per flag, so each section (anomalies, suggested fixes) gets its own notice
 * and only its own rows lock.
 */
type Choice = 'inherit' | 'on' | 'off';
type Section = 'anomalies' | 'remediation_suggestions';
type SectionBlock = Record<string, boolean | undefined>;

type RowDef = { key: string; flag: MlFeatureFlagName; testId: string; label: string; description: string };
type SectionDef = { section: Section; title: string; description: string; killSwitch: string; killSwitchTestId: string; rows: RowDef[] };

// Built from literal t() calls (not stored keys) so the i18n key-usage guard
// can verify every key resolves.
function buildSections(t: TFunction): SectionDef[] {
  return [
    {
      section: 'anomalies',
      title: t('orgSettingsPage.ai.mlFeatures.title'),
      description: t('orgSettingsPage.ai.mlFeatures.description'),
      killSwitch: t('orgSettingsPage.ai.mlFeatures.killSwitch'),
      killSwitchTestId: 'org-ml-kill-switch-notice',
      rows: [
        { key: 'enabled', flag: 'ml.anomalies.enabled', testId: 'org-ml-anomalies-enabled',
          label: t('orgSettingsPage.ai.mlFeatures.anomaliesEnabled'), description: t('orgSettingsPage.ai.mlFeatures.anomaliesEnabledDescription') },
        { key: 'create_alerts', flag: 'ml.anomalies.create_alerts', testId: 'org-ml-anomalies-create-alerts',
          label: t('orgSettingsPage.ai.mlFeatures.createAlerts'), description: t('orgSettingsPage.ai.mlFeatures.createAlertsDescription') },
      ],
    },
    {
      section: 'remediation_suggestions',
      title: t('orgSettingsPage.ai.mlFeatures.remediation.title'),
      description: t('orgSettingsPage.ai.mlFeatures.remediation.description'),
      killSwitch: t('orgSettingsPage.ai.mlFeatures.remediation.killSwitch'),
      killSwitchTestId: 'org-ml-remediation-kill-switch-notice',
      rows: [
        { key: 'enabled', flag: 'ml.remediation_suggestions.enabled', testId: 'org-ml-remediation-suggestions-enabled',
          label: t('orgSettingsPage.ai.mlFeatures.remediation.enabled'), description: t('orgSettingsPage.ai.mlFeatures.remediation.enabledDescription') },
      ],
    },
  ];
}

type OrgSettingsShape = Record<string, unknown> & { ml?: MlFeatureSettings };
type MlBlocks = Record<Section, SectionBlock>;

function blocksFrom(settings: OrgSettingsShape): MlBlocks {
  return {
    anomalies: { ...(settings.ml?.anomalies ?? {}) },
    remediation_suggestions: { ...(settings.ml?.remediation_suggestions ?? {}) },
  };
}

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
  const [blocks, setBlocks] = useState<MlBlocks>(() => blocksFrom(settings));
  const [resolved, setResolved] = useState<Partial<Record<MlFeatureFlagName, MlFeatureFlagResolution>>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setBlocks(blocksFrom(settings));
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

  // Scoped per section: ML_DISABLED_FLAGS is per flag, so an operator
  // disabling e.g. RCA (or only suggested fixes) must not lock the anomaly rows.
  const killSwitched = (def: SectionDef) =>
    def.rows.some((row) => resolved[row.flag]?.source === 'global_kill_switch');

  const change = async (section: Section, key: string, choice: Choice) => {
    if (busy) return;
    const previous = blocks;
    const nextBlock: SectionBlock = { ...blocks[section] };
    if (choice === 'inherit') delete nextBlock[key];
    else nextBlock[key] = choice === 'on';
    setBlocks({ ...blocks, [section]: nextBlock });
    setBusy(true);
    try {
      const ml: Record<string, unknown> = { ...(settings.ml ?? {}) };
      // Inherit on the last key leaves an empty block; drop it so the org
      // settings JSON carries no stale container.
      if (Object.keys(nextBlock).length === 0) delete ml[section];
      else ml[section] = nextBlock;
      const updatedSettings = { ...settings, ml };
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
      setBlocks(previous);
      if (!(err instanceof ActionError)) throw err;
    } finally {
      setBusy(false);
    }
  };

  const inheritLabel = (flag: MlFeatureFlagName) => {
    const r = resolved[flag];
    if (!r) return t('orgSettingsPage.ai.mlFeatures.inherit');
    const from = r.inheritedSource === 'partner_settings'
      ? t('orgSettingsPage.ai.mlFeatures.fromPartner')
      : t('orgSettingsPage.ai.mlFeatures.fromDefault');
    return r.inheritedEnabled
      ? t('orgSettingsPage.ai.mlFeatures.inheritOn', { from })
      : t('orgSettingsPage.ai.mlFeatures.inheritOff', { from });
  };

  return (
    <div className="mt-6 space-y-3" data-testid="org-ml-features-card">
      {buildSections(t).map((def, index) => {
        const locked = killSwitched(def);
        return (
          <div key={def.section} className={index > 0 ? 'space-y-3 pt-3' : 'space-y-3'}>
            <div>
              <h3 className="text-base font-semibold">{def.title}</h3>
              <p className="text-sm text-muted-foreground">{def.description}</p>
            </div>
            {locked && (
              <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200" data-testid={def.killSwitchTestId}>
                {def.killSwitch}
              </p>
            )}
            {def.rows.map((row) => (
              <div key={row.key} className="flex items-start justify-between gap-4 rounded-md border bg-muted/30 p-3">
                <span>
                  <span className="block text-sm font-medium">{row.label}</span>
                  <span className="block text-xs text-muted-foreground">{row.description}</span>
                </span>
                <select
                  data-testid={row.testId}
                  className="rounded-md border bg-background px-2 py-1 text-sm"
                  value={choiceFor(blocks[def.section][row.key])}
                  disabled={busy || locked}
                  onChange={(e) => void change(def.section, row.key, e.target.value as Choice)}
                >
                  <option value="inherit">{inheritLabel(row.flag)}</option>
                  <option value="on">{t('orgSettingsPage.ai.mlFeatures.on')}</option>
                  <option value="off">{t('orgSettingsPage.ai.mlFeatures.off')}</option>
                </select>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
