import { useState, useEffect } from 'react';
import { LifeBuoy } from 'lucide-react';
import type { FeatureTabProps } from './types';
import { FEATURE_META } from './types';
import { useFeatureLink } from './useFeatureLink';
import FeatureTabShell from './FeatureTabShell';

type HelperSettings = {
  enabled: boolean;
  showOpenPortal: boolean;
  showDeviceInfo: boolean;
  showRequestSupport: boolean;
  portalUrl?: string;
};

const defaults: HelperSettings = {
  enabled: false,
  showOpenPortal: true,
  showDeviceInfo: true,
  showRequestSupport: true,
  portalUrl: '',
};

export default function HelperTab({ policyId, existingLink, onLinkChanged, linkedPolicyId, parentLink }: FeatureTabProps) {
  const { save, remove, saving, error, clearError } = useFeatureLink(policyId);
  const isInherited = !!parentLink && !existingLink;
  const effectiveLink = existingLink ?? parentLink;
  const [settings, setSettings] = useState<HelperSettings>(() => ({
    ...defaults,
    ...(effectiveLink?.inlineSettings as Partial<HelperSettings> | undefined),
  }));

  useEffect(() => {
    const link = existingLink ?? parentLink;
    if (link?.inlineSettings) {
      setSettings((prev) => ({ ...prev, ...(link.inlineSettings as Partial<HelperSettings>) }));
    }
  }, [existingLink, parentLink]);

  const update = <K extends keyof HelperSettings>(key: K, value: HelperSettings[K]) =>
    setSettings((prev) => ({ ...prev, [key]: value }));

  const handleSave = async () => {
    clearError();
    const payload: HelperSettings = { ...settings };
    if (!payload.portalUrl) delete payload.portalUrl;
    const result = await save(existingLink?.id ?? null, {
      featureType: 'helper',
      featurePolicyId: linkedPolicyId,
      inlineSettings: payload,
    });
    if (result) onLinkChanged(result, 'helper');
  };

  const handleRemove = async () => {
    if (!existingLink) return;
    const ok = await remove(existingLink.id);
    if (ok) onLinkChanged(null, 'helper');
  };

  const handleOverride = async () => {
    clearError();
    const payload: HelperSettings = { ...settings };
    if (!payload.portalUrl) delete payload.portalUrl;
    const result = await save(null, {
      featureType: 'helper',
      featurePolicyId: linkedPolicyId,
      inlineSettings: payload,
    });
    if (result) onLinkChanged(result, 'helper');
  };

  const handleRevert = async () => {
    if (!existingLink) return;
    const ok = await remove(existingLink.id);
    if (ok) onLinkChanged(null, 'helper');
  };

  const meta = FEATURE_META.helper;

  return (
    <FeatureTabShell
      title={meta.label}
      description={meta.description}
      icon={<LifeBuoy className="h-5 w-5" />}
      isConfigured={!!existingLink || isInherited}
      saving={saving}
      error={error}
      onSave={handleSave}
      onRemove={existingLink && !linkedPolicyId ? handleRemove : undefined}
      isInherited={isInherited}
      onOverride={isInherited ? handleOverride : undefined}
      onRevert={!isInherited && !!linkedPolicyId && !!existingLink ? handleRevert : undefined}
    >
      <div className="space-y-6">
        {/* Deploy toggle */}
        <div className="flex items-center justify-between rounded-md border bg-background px-4 py-3">
          <div>
            <p className="text-sm font-medium">Deploy Helper to devices</p>
            <p className="text-xs text-muted-foreground">Install and run the Breeze Helper tray application on targeted devices.</p>
          </div>
          <button
            type="button"
            onClick={() => update('enabled', !settings.enabled)}
            className={`relative inline-flex h-6 w-11 items-center rounded-full border transition ${settings.enabled ? 'bg-emerald-500/80' : 'bg-muted'}`}
          >
            <span className={`inline-block h-5 w-5 rounded-full bg-white transition ${settings.enabled ? 'translate-x-5' : 'translate-x-1'}`} />
          </button>
        </div>

        {settings.enabled && (
          <div className="space-y-4">
            <h3 className="text-sm font-semibold">Tray Menu Options</h3>
            <p className="text-xs text-muted-foreground">Configure which items appear in the Helper's right-click context menu. Exit is always available.</p>

            {/* Open Portal */}
            <label className="flex items-center gap-3 rounded-md border bg-background px-4 py-3 cursor-pointer">
              <input
                type="checkbox"
                checked={settings.showOpenPortal}
                onChange={(e) => update('showOpenPortal', e.target.checked)}
                className="h-4 w-4 rounded border-gray-300"
              />
              <div>
                <p className="text-sm font-medium">Open Breeze Portal</p>
                <p className="text-xs text-muted-foreground">Opens the web portal in the user's browser.</p>
              </div>
            </label>

            {/* Device Info */}
            <label className="flex items-center gap-3 rounded-md border bg-background px-4 py-3 cursor-pointer">
              <input
                type="checkbox"
                checked={settings.showDeviceInfo}
                onChange={(e) => update('showDeviceInfo', e.target.checked)}
                className="h-4 w-4 rounded border-gray-300"
              />
              <div>
                <p className="text-sm font-medium">Device Info</p>
                <p className="text-xs text-muted-foreground">Shows device hostname, OS, status, and last check-in.</p>
              </div>
            </label>

            {/* Request Support */}
            <label className="flex items-center gap-3 rounded-md border bg-background px-4 py-3 cursor-pointer">
              <input
                type="checkbox"
                checked={settings.showRequestSupport}
                onChange={(e) => update('showRequestSupport', e.target.checked)}
                className="h-4 w-4 rounded border-gray-300"
              />
              <div>
                <p className="text-sm font-medium">Request Support</p>
                <p className="text-xs text-muted-foreground">Opens the Helper chat window for AI-assisted support.</p>
              </div>
            </label>

            {/* Portal URL */}
            <div>
              <label className="text-sm font-medium">Custom Portal URL</label>
              <input
                type="text"
                value={settings.portalUrl ?? ''}
                onChange={(e) => update('portalUrl', e.target.value)}
                placeholder="https://portal.example.com (defaults to server URL)"
                className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
              <p className="mt-1 text-xs text-muted-foreground">Leave blank to use the default Breeze server URL.</p>
            </div>
          </div>
        )}
      </div>
    </FeatureTabShell>
  );
}
