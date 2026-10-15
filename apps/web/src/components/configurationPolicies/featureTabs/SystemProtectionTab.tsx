import { useState, useEffect } from "react";
import { History, AlertTriangle, Info } from "lucide-react";
import {
  SYSTEM_PROTECTION_DEFAULTS,
  type SystemProtectionInlineSettings,
} from "@breeze/shared";
import type { FeatureTabProps } from "./types";
import { FEATURE_META } from "./types";
import { useFeatureLink } from "./useFeatureLink";
import FeatureTabShell from "./FeatureTabShell";
import { useTranslation } from "react-i18next";
import { i18n } from "@/lib/i18n";

// Inline settings for the `system_protection` feature (#4609 W03): whether the
// agent attempts a Windows System Restore checkpoint before each risky action.
// Defaults are legacy parity (patch on, the two new paths off) and come from the
// shared strict schema, so the tab and the API can't disagree.
type Settings = SystemProtectionInlineSettings;
type ToggleKey = "beforePatching" | "beforeScripts" | "beforeSoftwareInstall";

// The API schema is strict, so seed ONLY the known keys from a stored blob — an
// unknown key echoed back on save would 400 every edit.
function settingsFrom(raw: Record<string, unknown> | null | undefined): Settings {
  const out: Settings = { ...SYSTEM_PROTECTION_DEFAULTS };
  if (!raw) return out;
  for (const key of ["beforePatching", "beforeScripts", "beforeSoftwareInstall"] as const) {
    if (typeof raw[key] === "boolean") out[key] = raw[key] as boolean;
  }
  if (typeof raw.labelPrefix === "string" && raw.labelPrefix.trim().length > 0) {
    out.labelPrefix = raw.labelPrefix;
  }
  return out;
}

// Labels are thunks so they resolve in the active locale at render time.
const TOGGLES: ReadonlyArray<{ key: ToggleKey; testId: string; label: () => string; help: () => string }> = [
  {
    key: "beforePatching",
    testId: "system-protection-before-patching-toggle",
    label: () => i18n.t("policies:configurationPolicies.featureTabs.systemProtectionTab.beforePatching"),
    help: () => i18n.t("policies:configurationPolicies.featureTabs.systemProtectionTab.beforePatchingHelp"),
  },
  {
    key: "beforeScripts",
    testId: "system-protection-before-scripts-toggle",
    label: () => i18n.t("policies:configurationPolicies.featureTabs.systemProtectionTab.beforeScripts"),
    help: () => i18n.t("policies:configurationPolicies.featureTabs.systemProtectionTab.beforeScriptsHelp"),
  },
  {
    key: "beforeSoftwareInstall",
    testId: "system-protection-before-software-toggle",
    label: () => i18n.t("policies:configurationPolicies.featureTabs.systemProtectionTab.beforeSoftwareInstall"),
    help: () => i18n.t("policies:configurationPolicies.featureTabs.systemProtectionTab.beforeSoftwareInstallHelp"),
  },
];

export default function SystemProtectionTab({
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
  const [settings, setSettings] = useState<Settings>(() => settingsFrom(effectiveLink?.inlineSettings));

  // Re-seed whenever the link changes — INCLUDING when it goes away (remove /
  // revert with no parent), so the toggles never show a removed policy's values
  // under the platform-default note.
  useEffect(() => {
    setSettings(settingsFrom((existingLink ?? parentLink)?.inlineSettings));
  }, [existingLink, parentLink]);

  // The API rejects a blank prefix; a cleared field means "use the default".
  const payload = () => ({
    featureType: "system_protection" as const,
    featurePolicyId: null, // #5080: inline settings — never stamp the parent CONFIG policy's own id here
    inlineSettings: {
      ...settings,
      labelPrefix: settings.labelPrefix.trim() || SYSTEM_PROTECTION_DEFAULTS.labelPrefix,
    },
  });

  const handleSave = async () => {
    clearError();
    const result = await save(existingLink?.id ?? null, payload());
    if (result) onLinkChanged(result, "system_protection");
  };
  const handleRemove = async () => {
    if (!existingLink) return;
    const ok = await remove(existingLink.id);
    if (ok) onLinkChanged(null, "system_protection");
  };
  const handleOverride = async () => {
    clearError();
    const result = await save(null, payload());
    if (result) onLinkChanged(result, "system_protection");
  };
  const handleRevert = async () => {
    if (!existingLink) return;
    const ok = await remove(existingLink.id);
    if (ok) onLinkChanged(null, "system_protection");
  };

  const meta = FEATURE_META.system_protection;
  const isPlatformDefault = !existingLink && !parentLink;

  return (
    <FeatureTabShell
      title={meta.label}
      description={meta.description}
      icon={<History className="h-5 w-5" />}
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
        {isPlatformDefault && (
          <div
            data-testid="system-protection-platform-default-note"
            className="flex items-start gap-2 rounded-md border bg-muted/40 px-4 py-3 text-sm"
          >
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <p>{i18n.t("policies:configurationPolicies.featureTabs.systemProtectionTab.platformDefaultNote")}</p>
          </div>
        )}

        <div className="space-y-3">
          {TOGGLES.map(({ key, testId, label, help }) => (
            <div
              key={key}
              className="flex items-center justify-between gap-4 rounded-md border bg-background px-4 py-3"
            >
              <div>
                <p className="text-sm font-medium">{label()}</p>
                <p className="text-xs text-muted-foreground">{help()}</p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={settings[key]}
                aria-label={label()}
                data-testid={testId}
                onClick={() => setSettings((prev) => ({ ...prev, [key]: !prev[key] }))}
                className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition ${settings[key] ? "bg-emerald-500/80" : "bg-muted"}`}
              >
                <span
                  className={`inline-block h-5 w-5 rounded-full bg-white transition ${settings[key] ? "translate-x-5" : "translate-x-1"}`}
                />
              </button>
            </div>
          ))}
        </div>

        {!settings.beforePatching && (
          <div
            data-testid="system-protection-legacy-agent-warning"
            className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <p>{i18n.t("policies:configurationPolicies.featureTabs.systemProtectionTab.legacyAgentWarning")}</p>
          </div>
        )}

        <div className="space-y-1">
          <label htmlFor="system-protection-label-prefix" className="text-sm font-medium">
            {i18n.t("policies:configurationPolicies.featureTabs.systemProtectionTab.labelPrefix")}
          </label>
          <input
            id="system-protection-label-prefix"
            data-testid="system-protection-label-prefix-input"
            type="text"
            maxLength={64}
            value={settings.labelPrefix}
            placeholder={SYSTEM_PROTECTION_DEFAULTS.labelPrefix}
            onChange={(e) => setSettings((prev) => ({ ...prev, labelPrefix: e.target.value }))}
            className="h-9 w-full max-w-sm rounded-md border bg-background px-3 text-sm"
          />
          <p className="text-xs text-muted-foreground">{i18n.t("policies:configurationPolicies.featureTabs.systemProtectionTab.labelPrefixHelp")}</p>
        </div>

        <div className="rounded-md border bg-muted/40 px-4 py-3">
          <p className="text-sm font-medium">{i18n.t("policies:configurationPolicies.featureTabs.systemProtectionTab.aboutTitle")}</p>
          <p className="mt-1 text-xs text-muted-foreground">{i18n.t("policies:configurationPolicies.featureTabs.systemProtectionTab.aboutBody")}</p>
        </div>
      </div>
    </FeatureTabShell>
  );
}
