import { useEffect, useState } from 'react';
import { AlertTriangle, Info, Power } from 'lucide-react';
import { WAKE_BUTTON_MODES, WAKE_ON_LAN_PLATFORM_DEFAULT, type WakeButtonMode } from '@breeze/shared';
import { useTranslation } from 'react-i18next';
import type { FeatureTabProps } from './types';
import { FEATURE_META } from './types';
import { useFeatureLink } from './useFeatureLink';
import FeatureTabShell from './FeatureTabShell';
import WakeStatusPanel from './WakeStatusPanel';

// Inline settings for the `wake_on_lan` feature (#10838): when the Wake button
// shows for an offline device. Writes to NIC/firmware settings arrive in a later
// wave, so there is deliberately no "configure settings" control here and the
// saved blob always carries `configureSettings: false` (the API schema is strict).
//
// Settings home (docs/agents/settings.md rule 9): this tab, at the policy
// assignment hierarchy, resolved per device by resolveWakeAvailability.
function modeFrom(raw: Record<string, unknown> | null | undefined): WakeButtonMode {
  const mode = raw?.buttonMode;
  return (WAKE_BUTTON_MODES as readonly unknown[]).includes(mode)
    ? (mode as WakeButtonMode)
    : WAKE_ON_LAN_PLATFORM_DEFAULT.buttonMode;
}

export default function WakeOnLanTab({
  policyId,
  existingLink,
  onLinkChanged,
  linkedPolicyId,
  parentLink,
}: FeatureTabProps) {
  const { t } = useTranslation('policies');
  const { save, remove, saving, error, clearError } = useFeatureLink(policyId);
  const isInherited = !!parentLink && !existingLink;
  const effectiveLink = existingLink ?? parentLink;
  const [mode, setMode] = useState<WakeButtonMode>(() => modeFrom(effectiveLink?.inlineSettings));

  // Re-seed whenever the link changes, including when it goes away.
  useEffect(() => {
    setMode(modeFrom((existingLink ?? parentLink)?.inlineSettings));
  }, [existingLink, parentLink]);

  const payload = () => ({
    featureType: 'wake_on_lan' as const,
    featurePolicyId: null,
    inlineSettings: { configureSettings: false, buttonMode: mode },
  });

  const handleSave = async () => {
    clearError();
    const result = await save(existingLink?.id ?? null, payload());
    if (result) onLinkChanged(result, 'wake_on_lan');
  };
  const handleRemove = async () => {
    if (!existingLink) return;
    const ok = await remove(existingLink.id);
    if (ok) onLinkChanged(null, 'wake_on_lan');
  };
  const handleOverride = async () => {
    clearError();
    const result = await save(null, payload());
    if (result) onLinkChanged(result, 'wake_on_lan');
  };

  const meta = FEATURE_META.wake_on_lan;
  const isPlatformDefault = !existingLink && !parentLink;
  const prefix = 'configurationPolicies.featureTabs.wakeOnLanTab';

  return (
    <div className="space-y-6">
    <FeatureTabShell
      title={meta.label}
      description={meta.description}
      icon={<Power className="h-5 w-5" />}
      isConfigured={!!existingLink || isInherited}
      saving={saving}
      error={error}
      onSave={handleSave}
      onRemove={existingLink && !linkedPolicyId ? handleRemove : undefined}
      isInherited={isInherited}
      onOverride={isInherited ? handleOverride : undefined}
      onRevert={!isInherited && !!linkedPolicyId && !!existingLink ? handleRemove : undefined}
    >
      <div className="space-y-6">
        {isPlatformDefault && (
          <div
            data-testid="wake-platform-default-note"
            className="flex items-start gap-2 rounded-md border bg-muted/40 px-4 py-3 text-sm"
          >
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <p>{t('configurationPolicies.featureTabs.wakeOnLanTab.platformDefaultNote')}</p>
          </div>
        )}

        <fieldset className="space-y-3">
          <legend className="text-sm font-medium">{t('configurationPolicies.featureTabs.wakeOnLanTab.modeTitle')}</legend>
          {WAKE_BUTTON_MODES.map((value) => (
            <label
              key={value}
              className="flex cursor-pointer items-start gap-3 rounded-md border bg-background px-4 py-3"
            >
              <input
                type="radio"
                name={`wake-button-mode-${policyId}`}
                data-testid={`wake-button-mode-${value}`}
                checked={mode === value}
                onChange={() => setMode(value)}
                className="mt-1"
              />
              <span>
                <span className="block text-sm font-medium">{t(/* i18n-dynamic */ `${prefix}.mode.${value}`)}</span>
                <span className="block text-xs text-muted-foreground">{t(/* i18n-dynamic */ `${prefix}.mode.${value}Help`)}</span>
              </span>
            </label>
          ))}
        </fieldset>

        {mode === 'verified' && (
          <div
            role="note"
            data-testid="wake-verified-warning"
            className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-4 py-3 text-sm"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
            <p>{t('configurationPolicies.featureTabs.wakeOnLanTab.verifiedWarning')}</p>
          </div>
        )}

        <div className="rounded-md border bg-muted/40 px-4 py-3">
          <p className="text-sm font-medium">{t('configurationPolicies.featureTabs.wakeOnLanTab.aboutTitle')}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t('configurationPolicies.featureTabs.wakeOnLanTab.aboutBody')}</p>
        </div>
      </div>
    </FeatureTabShell>
    {/* A status view, not a form: outside the shell so a read-only viewer's
        disabled fieldset does not lock its filter chips and paging, and its
        clicks never mark the feature dirty (#12469). */}
    {effectiveLink && <WakeStatusPanel policyId={policyId} />}
    </div>
  );
}
