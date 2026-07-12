import { useState, useEffect } from "react";
import { KeyRound } from "lucide-react";
import type { FeatureTabProps } from "./types";
import { FEATURE_META } from "./types";
import { useFeatureLink } from "./useFeatureLink";
import FeatureTabShell from "./FeatureTabShell";
import { useTranslation } from "react-i18next";
import { i18n } from "@/lib/i18n";
type PamSettings = {
  uacInterceptionEnabled: boolean;
};
// Default OFF (opt-in) — matches agent behavior when no policy assigns this
// feature: a device with no 'pam' policy does not capture UAC prompts.
const defaults: PamSettings = {
  uacInterceptionEnabled: false,
};
export default function PamTab({
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
  const [settings, setSettings] = useState<PamSettings>(() => ({
    ...defaults,
    ...(effectiveLink?.inlineSettings as Partial<PamSettings> | undefined),
  }));
  useEffect(() => {
    const link = existingLink ?? parentLink;
    if (link?.inlineSettings) {
      setSettings((prev) => ({
        ...prev,
        ...(link.inlineSettings as Partial<PamSettings>),
      }));
    }
  }, [existingLink, parentLink]);
  const handleSave = async () => {
    clearError();
    const result = await save(existingLink?.id ?? null, {
      featureType: "pam",
      featurePolicyId: linkedPolicyId,
      inlineSettings: { ...settings },
    });
    if (result) onLinkChanged(result, "pam");
  };
  const handleRemove = async () => {
    if (!existingLink) return;
    const ok = await remove(existingLink.id);
    if (ok) onLinkChanged(null, "pam");
  };
  const handleOverride = async () => {
    clearError();
    const result = await save(null, {
      featureType: "pam",
      featurePolicyId: linkedPolicyId,
      inlineSettings: { ...settings },
    });
    if (result) onLinkChanged(result, "pam");
  };
  const handleRevert = async () => {
    if (!existingLink) return;
    const ok = await remove(existingLink.id);
    if (ok) onLinkChanged(null, "pam");
  };
  const meta = FEATURE_META.pam;
  return (
    <FeatureTabShell
      title={meta.label}
      description={meta.description}
      icon={<KeyRound className="h-5 w-5" />}
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
        {/* UAC interception toggle */}
        <div className="flex items-center justify-between rounded-md border bg-background px-4 py-3">
          <div>
            <p className="text-sm font-medium">
              {i18n.t(
                "policies:configurationPolicies.featureTabs.pamTab.captureWindowsUACElevationPrompts",
              )}
            </p>
            <p className="text-xs text-muted-foreground">
              {i18n.t(
                "policies:configurationPolicies.featureTabs.pamTab.theAgentObservesUACConsentPromptsAnd",
              )}
            </p>
          </div>
          <button
            type="button"
            data-testid="pam-tab-capture-toggle"
            onClick={() =>
              setSettings((prev) => ({
                ...prev,
                uacInterceptionEnabled: !prev.uacInterceptionEnabled,
              }))
            }
            className={`relative inline-flex h-6 w-11 items-center rounded-full border transition ${settings.uacInterceptionEnabled ? "bg-emerald-500/80" : "bg-muted"}`}
          >
            <span
              className={`inline-block h-5 w-5 rounded-full bg-white transition ${settings.uacInterceptionEnabled ? "translate-x-5" : "translate-x-1"}`}
            />
          </button>
        </div>

        {/* Pointer to the PAM control plane */}
        <div className="rounded-md border bg-muted/40 px-4 py-3">
          <p className="text-sm font-medium">
            {i18n.t(
              "policies:configurationPolicies.featureTabs.pamTab.approvalRulesLiveInThePAMConsole",
            )}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {i18n.t(
              "policies:configurationPolicies.featureTabs.pamTab.thisPolicyOnlyControlsWhetherDevicesCapture",
            )}{" "}
            <a
              href="/pam"
              className="underline underline-offset-2 hover:text-foreground"
            >
              {i18n.t(
                "policies:configurationPolicies.featureTabs.pamTab.privilegedAccessConsole",
              )}
            </a>
            .
          </p>
        </div>
      </div>
    </FeatureTabShell>
  );
}
