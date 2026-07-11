import { useState, useEffect } from "react";
import { LifeBuoy } from "lucide-react";
import type { FeatureTabProps } from "./types";
import { FEATURE_META } from "./types";
import { useFeatureLink } from "./useFeatureLink";
import FeatureTabShell from "./FeatureTabShell";
import { useTranslation } from "react-i18next";
import { i18n } from "@/lib/i18n";
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
  portalUrl: "",
};
export default function HelperTab({
  policyId,
  existingLink,
  onLinkChanged,
  linkedPolicyId,
  parentLink,
}: FeatureTabProps) {
  useTranslation("policies");
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
      setSettings((prev) => ({
        ...prev,
        ...(link.inlineSettings as Partial<HelperSettings>),
      }));
    }
  }, [existingLink, parentLink]);
  const update = <K extends keyof HelperSettings>(
    key: K,
    value: HelperSettings[K],
  ) => setSettings((prev) => ({ ...prev, [key]: value }));
  const handleSave = async () => {
    clearError();
    const payload: HelperSettings = { ...settings };
    if (!payload.portalUrl) delete payload.portalUrl;
    const result = await save(existingLink?.id ?? null, {
      featureType: "helper",
      featurePolicyId: linkedPolicyId,
      inlineSettings: payload,
    });
    if (result) onLinkChanged(result, "helper");
  };
  const handleRemove = async () => {
    if (!existingLink) return;
    const ok = await remove(existingLink.id);
    if (ok) onLinkChanged(null, "helper");
  };
  const handleOverride = async () => {
    clearError();
    const payload: HelperSettings = { ...settings };
    if (!payload.portalUrl) delete payload.portalUrl;
    const result = await save(null, {
      featureType: "helper",
      featurePolicyId: linkedPolicyId,
      inlineSettings: payload,
    });
    if (result) onLinkChanged(result, "helper");
  };
  const handleRevert = async () => {
    if (!existingLink) return;
    const ok = await remove(existingLink.id);
    if (ok) onLinkChanged(null, "helper");
  };
  const meta = FEATURE_META.helper;
  return (
    <FeatureTabShell
      title={meta.label}
      description={meta.description}
      icon={<LifeBuoy className="h-5 w-5" />}
      isConfigured={!!existingLink || isInherited}
      configuredButInactive={!!existingLink && !settings.enabled}
      saving={saving}
      error={error}
      onSave={handleSave}
      onRemove={existingLink && !linkedPolicyId ? handleRemove : undefined}
      isInherited={isInherited}
      onOverride={isInherited ? handleOverride : undefined}
      onRevert={
        !isInherited && !!linkedPolicyId && !!existingLink
          ? handleRevert
          : undefined
      }
    >
      <div className="space-y-6">
        {/* Deploy toggle */}
        <div className="flex items-center justify-between rounded-md border bg-background px-4 py-3">
          <div>
            <p className="text-sm font-medium">
              {i18n.t(
                "policies:configurationPolicies.featureTabs.helperTab.deployBreezeAssistToDevices",
              )}
            </p>
            <p className="text-xs text-muted-foreground">
              {i18n.t(
                "policies:configurationPolicies.featureTabs.helperTab.installAndRunTheBreezeAssistTray",
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={() => update("enabled", !settings.enabled)}
            className={`relative inline-flex h-6 w-11 items-center rounded-full border transition ${settings.enabled ? "bg-emerald-500/80" : "bg-muted"}`}
          >
            <span
              className={`inline-block h-5 w-5 rounded-full bg-white transition ${settings.enabled ? "translate-x-5" : "translate-x-1"}`}
            />
          </button>
        </div>

        {/*
          Tray Menu Options stay visible even when deploy is off, in a disabled
          state, so the available configuration is discoverable rather than
          appearing as "nothing else to configure" (#1863).
        */}
        <div className="space-y-4">
          <div>
            <h3 className="text-sm font-semibold">
              {i18n.t(
                "policies:configurationPolicies.featureTabs.helperTab.trayMenuOptions",
              )}
            </h3>
            <p className="text-xs text-muted-foreground">
              {i18n.t(
                "policies:configurationPolicies.featureTabs.helperTab.configureWhichItemsAppearInTheBreeze",
              )}
            </p>
            {!settings.enabled && (
              <p className="mt-1 text-xs italic text-muted-foreground">
                {i18n.t(
                  "policies:configurationPolicies.featureTabs.helperTab.enableDeployBreezeAssistToDevicesAbove",
                )}
              </p>
            )}
          </div>

          <div
            className={`space-y-4 ${settings.enabled ? "" : "pointer-events-none opacity-50"}`}
            aria-disabled={!settings.enabled}
          >
            {/* Open Portal */}
            <label className="flex items-center gap-3 rounded-md border bg-background px-4 py-3 cursor-pointer">
              <input
                type="checkbox"
                checked={settings.showOpenPortal}
                disabled={!settings.enabled}
                onChange={(e) => update("showOpenPortal", e.target.checked)}
                className="h-4 w-4 rounded border-border"
              />
              <div>
                <p className="text-sm font-medium">
                  {i18n.t(
                    "policies:configurationPolicies.featureTabs.helperTab.openBreezePortal",
                  )}
                </p>
                <p className="text-xs text-muted-foreground">
                  {i18n.t(
                    "policies:configurationPolicies.featureTabs.helperTab.opensTheWebPortalInTheUser",
                  )}
                </p>
              </div>
            </label>

            {/* Device Info */}
            <label className="flex items-center gap-3 rounded-md border bg-background px-4 py-3 cursor-pointer">
              <input
                type="checkbox"
                checked={settings.showDeviceInfo}
                disabled={!settings.enabled}
                onChange={(e) => update("showDeviceInfo", e.target.checked)}
                className="h-4 w-4 rounded border-border"
              />
              <div>
                <p className="text-sm font-medium">
                  {i18n.t(
                    "policies:configurationPolicies.featureTabs.helperTab.deviceInfo",
                  )}
                </p>
                <p className="text-xs text-muted-foreground">
                  {i18n.t(
                    "policies:configurationPolicies.featureTabs.helperTab.showsDeviceHostnameOSStatusAndLast",
                  )}
                </p>
              </div>
            </label>

            {/* Request Support */}
            <label className="flex items-center gap-3 rounded-md border bg-background px-4 py-3 cursor-pointer">
              <input
                type="checkbox"
                checked={settings.showRequestSupport}
                disabled={!settings.enabled}
                onChange={(e) =>
                  update("showRequestSupport", e.target.checked)
                }
                className="h-4 w-4 rounded border-border"
              />
              <div>
                <p className="text-sm font-medium">
                  {i18n.t(
                    "policies:configurationPolicies.featureTabs.helperTab.requestSupport",
                  )}
                </p>
                <p className="text-xs text-muted-foreground">
                  {i18n.t(
                    "policies:configurationPolicies.featureTabs.helperTab.opensTheBreezeAssistChatWindowFor",
                  )}
                </p>
              </div>
            </label>

            {/* Portal URL */}
            <div>
              <label className="text-sm font-medium">
                {i18n.t(
                  "policies:configurationPolicies.featureTabs.helperTab.customPortalURL",
                )}
              </label>
              <input
                type="text"
                value={settings.portalUrl ?? ""}
                disabled={!settings.enabled}
                onChange={(e) => update("portalUrl", e.target.value)}
                placeholder={i18n.t(
                  "policies:configurationPolicies.featureTabs.helperTab.httpsPortalExampleComDefaultsToServer",
                )}
                className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {i18n.t(
                  "policies:configurationPolicies.featureTabs.helperTab.leaveBlankToUseTheDefaultBreeze",
                )}
              </p>
            </div>
          </div>
        </div>
      </div>
    </FeatureTabShell>
  );
}
