import { useState, useEffect } from "react";
import { ShieldCheck } from "lucide-react";
import type { FeatureTabProps } from "./types";
import { FEATURE_META } from "./types";
import { useFeatureLink } from "./useFeatureLink";
import FeatureTabShell from "./FeatureTabShell";
import { useTranslation } from "react-i18next";
import { i18n } from "@/lib/i18n";
type WarrantySettings = {
  enabled: boolean;
  warnDays: number;
  criticalDays: number;
};
const defaults: WarrantySettings = {
  enabled: true,
  warnDays: 90,
  criticalDays: 30,
};
export default function WarrantyTab({
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
  const [settings, setSettings] = useState<WarrantySettings>(() => ({
    ...defaults,
    ...(effectiveLink?.inlineSettings as Partial<WarrantySettings> | undefined),
  }));
  useEffect(() => {
    const link = existingLink ?? parentLink;
    if (link?.inlineSettings) {
      setSettings((prev) => ({
        ...prev,
        ...(link.inlineSettings as Partial<WarrantySettings>),
      }));
    }
  }, [existingLink, parentLink]);
  const update = <K extends keyof WarrantySettings>(
    key: K,
    value: WarrantySettings[K],
  ) => setSettings((prev) => ({ ...prev, [key]: value }));
  const handleSave = async () => {
    clearError();
    const result = await save(existingLink?.id ?? null, {
      featureType: "warranty",
      featurePolicyId: linkedPolicyId,
      inlineSettings: settings,
    });
    if (result) onLinkChanged(result, "warranty");
  };
  const handleRemove = async () => {
    if (!existingLink) return;
    const ok = await remove(existingLink.id);
    if (ok) onLinkChanged(null, "warranty");
  };
  const handleOverride = async () => {
    clearError();
    const result = await save(null, {
      featureType: "warranty",
      featurePolicyId: linkedPolicyId,
      inlineSettings: settings,
    });
    if (result) onLinkChanged(result, "warranty");
  };
  const handleRevert = async () => {
    if (!existingLink) return;
    const ok = await remove(existingLink.id);
    if (ok) onLinkChanged(null, "warranty");
  };
  const meta = FEATURE_META.warranty;
  return (
    <FeatureTabShell
      title={meta.label}
      description={meta.description}
      icon={<ShieldCheck className="h-5 w-5" />}
      isConfigured={!!existingLink || isInherited}
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
        {/* Opt-in clarification: warranty alerting only happens when this feature is
            assigned and enabled (#1320). */}
        <p className="rounded-md border border-border bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
          {i18n.t(
            "policies:configurationPolicies.featureTabs.warrantyTab.warrantyAlertingIsOptInDevicesWith",
          )}
        </p>

        {/* Enable toggle */}
        <div className="flex items-center justify-between rounded-md border bg-background px-4 py-3">
          <div>
            <p className="text-sm font-medium">
              {i18n.t(
                "policies:configurationPolicies.featureTabs.warrantyTab.enableWarrantyExpiryAlerts",
              )}
            </p>
            <p className="text-xs text-muted-foreground">
              {i18n.t(
                "policies:configurationPolicies.featureTabs.warrantyTab.generateAlertsWhenFixedTermDeviceWarranties",
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

        {settings.enabled && (
          <div className="grid gap-6 sm:grid-cols-2">
            <div>
              <label className="text-sm font-medium">
                {i18n.t(
                  "policies:configurationPolicies.featureTabs.warrantyTab.warningThresholdDays",
                )}
              </label>
              <input
                type="number"
                min={1}
                max={365}
                value={settings.warnDays}
                onChange={(e) =>
                  update("warnDays", Number(e.target.value) || 90)
                }
                className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {i18n.t(
                  "policies:configurationPolicies.featureTabs.warrantyTab.generateAWarningAlertWhenWarrantyExpires",
                )}
              </p>
            </div>

            <div>
              <label className="text-sm font-medium">
                {i18n.t(
                  "policies:configurationPolicies.featureTabs.warrantyTab.criticalThresholdDays",
                )}
              </label>
              <input
                type="number"
                min={1}
                max={365}
                value={settings.criticalDays}
                onChange={(e) =>
                  update("criticalDays", Number(e.target.value) || 30)
                }
                className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {i18n.t(
                  "policies:configurationPolicies.featureTabs.warrantyTab.generateACriticalAlertWhenWarrantyExpires",
                )}
              </p>
            </div>
          </div>
        )}
      </div>
    </FeatureTabShell>
  );
}
