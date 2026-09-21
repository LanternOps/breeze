import { useState, useEffect } from "react";
import { ShieldCheck, Plus, Trash2 } from "lucide-react";
import type { FeatureTabProps } from "./types";
import { FEATURE_META } from "./types";
import { useFeatureLink } from "./useFeatureLink";
import FeatureTabShell from "./FeatureTabShell";
import { useTranslation } from "react-i18next";
import { i18n } from "@/lib/i18n";
import {
  SECURITY_SCAN_TYPES,
  type SecurityScanSettings,
  SECURITY_SCAN_SETTINGS_DEFAULTS,
  parseSecurityScanSettings,
  SECURITY_SCAN_MINUTE_OPTIONS,
  SECURITY_SCAN_HOUR_OPTIONS,
  SECURITY_SCAN_DAY_OF_MONTH_OPTIONS,
  SECURITY_SCAN_MAX_FILE_SIZE_MB_RANGE,
  SECURITY_SCAN_TIMEOUT_MINUTES_RANGE,
} from "@breeze/shared";
function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between rounded-md border bg-background px-4 py-3">
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <button
        type="button"
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 items-center rounded-full border transition ${checked ? "bg-emerald-500/80" : "bg-muted"}`}
      >
        <span
          className={`inline-block h-5 w-5 rounded-full bg-white transition ${checked ? "translate-x-5" : "translate-x-1"}`}
        />
      </button>
    </div>
  );
}
const createDayOfWeekOptions = () => [
  {
    label: i18n.t("policies:configurationPolicies.featureTabs.securityTab.any"),
    value: "*",
  },
  {
    label: i18n.t("policies:configurationPolicies.featureTabs.securityTab.mon"),
    value: "1",
  },
  {
    label: i18n.t("policies:configurationPolicies.featureTabs.securityTab.tue"),
    value: "2",
  },
  {
    label: i18n.t("policies:configurationPolicies.featureTabs.securityTab.wed"),
    value: "3",
  },
  {
    label: i18n.t("policies:configurationPolicies.featureTabs.securityTab.thu"),
    value: "4",
  },
  {
    label: i18n.t("policies:configurationPolicies.featureTabs.securityTab.fri"),
    value: "5",
  },
  {
    label: i18n.t("policies:configurationPolicies.featureTabs.securityTab.sat"),
    value: "6",
  },
  {
    label: i18n.t("policies:configurationPolicies.featureTabs.securityTab.sun"),
    value: "0",
  },
];
const clamp = (value: number, [min, max]: readonly [number, number]): number =>
  Math.min(max, Math.max(min, value));
export default function SecurityTab({
  policyId,
  existingLink,
  onLinkChanged,
  parentLink,
}: FeatureTabProps) {
  useTranslation("policies");
  const dayOfWeekOptions = createDayOfWeekOptions();
  const { save, remove, saving, error, clearError } = useFeatureLink(policyId);
  // #5080: inheritance display — mirrors PamTab.tsx. `effectiveLink` seeds the
  // form from the parent's settings when this policy has no override of its
  // own; FeatureTabShell renders the form read-only (opacity + pointer-events)
  // whenever isInherited is true.
  const isInherited = !!parentLink && !existingLink;
  const effectiveLink = existingLink ?? parentLink;
  const [settings, setSettings] = useState<SecurityScanSettings>(() =>
    parseSecurityScanSettings(effectiveLink?.inlineSettings),
  );
  const [newExclusion, setNewExclusion] = useState("");
  useEffect(() => {
    const link = existingLink ?? parentLink;
    if (link?.inlineSettings) {
      setSettings(parseSecurityScanSettings(link.inlineSettings));
    }
  }, [existingLink, parentLink]);
  const meta = FEATURE_META.security;
  const update = <K extends keyof SecurityScanSettings>(
    key: K,
    value: SecurityScanSettings[K],
  ) => setSettings((prev) => ({ ...prev, [key]: value }));
  const handleAddExclusion = () => {
    const trimmed = newExclusion.trim();
    if (!trimmed || settings.exclusions.includes(trimmed)) return;
    update("exclusions", [...settings.exclusions, trimmed]);
    setNewExclusion("");
  };
  const handleRemoveExclusion = (path: string) =>
    update(
      "exclusions",
      settings.exclusions.filter((e) => e !== path),
    );
  const handleSave = async () => {
    clearError();
    const result = await save(existingLink?.id ?? null, {
      featureType: "security",
      featurePolicyId: null, // #5080: inline settings — never stamp the parent CONFIG policy's own id here
      inlineSettings: settings,
    });
    if (result) onLinkChanged(result, "security");
  };
  const handleRemove = async () => {
    if (!existingLink) return;
    const ok = await remove(existingLink.id);
    if (ok) onLinkChanged(null, "security");
  };
  // Revert = delete the child's own override link, falling back to the
  // parent's (spec "Semantics"). Reported via onLinkChanged like every other
  // remove path, so the detail page's own featureLinks state doesn't go stale.
  const handleRevert = async () => {
    if (!existingLink) return;
    const ok = await remove(existingLink.id);
    if (ok) onLinkChanged(null, "security");
  };
  return (
    <FeatureTabShell
      title={meta.label}
      description={meta.description}
      icon={<ShieldCheck className="h-5 w-5" />}
      isConfigured={!!existingLink || isInherited}
      saving={saving}
      error={error}
      onSave={handleSave}
      // Gated on THIS FEATURE's own parentLink, not the policy-level
      // linkedPolicyId the older inline tabs (PamTab, DeviceLifecycleTab, ...)
      // use. Policy-level gating shows "Revert to Parent" whenever the policy
      // has ANY parent, even when that parent has no link for this particular
      // feature — reverting then "falls back" to nothing, which is misleading.
      // Feature-level gating shows plain "Remove" in that case instead, which
      // is accurate: there is no parent value to revert to.
      onRemove={!parentLink ? handleRemove : undefined}
      isInherited={isInherited}
      onOverride={isInherited ? handleSave : undefined}
      onRevert={
        !isInherited && !!parentLink && !!existingLink ? handleRevert : undefined
      }
    >
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Scan settings */}
        <div className="space-y-3">
          <h3 className="text-sm font-semibold">
            {i18n.t(
              "policies:configurationPolicies.featureTabs.securityTab.scanSettings",
            )}
          </h3>
          <div>
            <label className="text-xs uppercase text-muted-foreground">
              {i18n.t(
                "policies:configurationPolicies.featureTabs.securityTab.scanType",
              )}
            </label>
            <select
              data-testid="security-scan-type"
              value={settings.scanType}
              onChange={(e) =>
                update("scanType", e.target.value as SecurityScanSettings["scanType"])
              }
              className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
            >
              {SECURITY_SCAN_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type === "quick"
                    ? i18n.t(
                        "policies:configurationPolicies.featureTabs.securityTab.quickScan",
                      )
                    : i18n.t(
                        "policies:configurationPolicies.featureTabs.securityTab.fullScan",
                      )}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs uppercase text-muted-foreground">
              {i18n.t(
                "policies:configurationPolicies.featureTabs.securityTab.maxFileSizeMb",
              )}
            </label>
            <input
              type="number"
              data-testid="security-max-file-size-mb"
              value={settings.maxFileSizeMb}
              min={SECURITY_SCAN_MAX_FILE_SIZE_MB_RANGE[0]}
              max={SECURITY_SCAN_MAX_FILE_SIZE_MB_RANGE[1]}
              onChange={(e) =>
                update(
                  "maxFileSizeMb",
                  clamp(
                    Number.parseInt(e.target.value, 10) || SECURITY_SCAN_SETTINGS_DEFAULTS.maxFileSizeMb,
                    SECURITY_SCAN_MAX_FILE_SIZE_MB_RANGE,
                  ),
                )
              }
              className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
            />
          </div>
          <div>
            <label className="text-xs uppercase text-muted-foreground">
              {i18n.t(
                "policies:configurationPolicies.featureTabs.securityTab.scanTimeoutMinutes",
              )}
            </label>
            <input
              type="number"
              data-testid="security-scan-timeout-minutes"
              value={settings.scanTimeoutMinutes}
              min={SECURITY_SCAN_TIMEOUT_MINUTES_RANGE[0]}
              max={SECURITY_SCAN_TIMEOUT_MINUTES_RANGE[1]}
              onChange={(e) =>
                update(
                  "scanTimeoutMinutes",
                  clamp(
                    Number.parseInt(e.target.value, 10) || SECURITY_SCAN_SETTINGS_DEFAULTS.scanTimeoutMinutes,
                    SECURITY_SCAN_TIMEOUT_MINUTES_RANGE,
                  ),
                )
              }
              className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
            />
          </div>
        </div>

        {/* Actions */}
        <div className="space-y-3">
          <h3 className="text-sm font-semibold">
            {i18n.t("common:labels.actions")}
          </h3>
          <ToggleRow
            label={i18n.t(
              "policies:configurationPolicies.featureTabs.securityTab.autoQuarantine",
            )}
            description={i18n.t(
              "policies:configurationPolicies.featureTabs.securityTab.moveThreatsToQuarantineImmediately",
            )}
            checked={settings.autoQuarantine}
            onChange={(v) => update("autoQuarantine", v)}
          />
        </div>
      </div>

      {/* Scheduled scans */}
      <div className="mt-6">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">
            {i18n.t(
              "policies:configurationPolicies.featureTabs.securityTab.scheduledScans",
            )}
          </h3>
          <button
            type="button"
            onClick={() => update("scheduledScans", !settings.scheduledScans)}
            className={`rounded-full border px-3 py-1 text-xs font-semibold ${settings.scheduledScans ? "bg-emerald-500/15 text-emerald-700" : "bg-muted text-muted-foreground"}`}
          >
            {settings.scheduledScans
              ? i18n.t("common:states.enabled")
              : i18n.t("common:states.disabled")}
          </button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {i18n.t(
            "policies:configurationPolicies.featureTabs.securityTab.scanRunsServerSideDescription",
          )}
        </p>
        <div
          className={`mt-3 grid gap-3 sm:grid-cols-4 ${settings.scheduledScans ? "" : "opacity-50 pointer-events-none"}`}
        >
          <div>
            <label className="text-xs uppercase text-muted-foreground">
              {i18n.t(
                "policies:configurationPolicies.featureTabs.securityTab.minute",
              )}
            </label>
            <select
              value={settings.scanMinute}
              onChange={(e) => update("scanMinute", e.target.value)}
              className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
            >
              {SECURITY_SCAN_MINUTE_OPTIONS.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs uppercase text-muted-foreground">
              {i18n.t(
                "policies:configurationPolicies.featureTabs.securityTab.hour",
              )}
            </label>
            <select
              value={settings.scanHour}
              onChange={(e) => update("scanHour", e.target.value)}
              className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
            >
              {SECURITY_SCAN_HOUR_OPTIONS.map((o) => (
                <option key={o} value={o}>
                  {o.padStart(2, "0")}:00
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs uppercase text-muted-foreground">
              {i18n.t(
                "policies:configurationPolicies.featureTabs.securityTab.dayOfMonth",
              )}
            </label>
            <select
              value={settings.scanDayOfMonth}
              onChange={(e) => update("scanDayOfMonth", e.target.value)}
              className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
            >
              {SECURITY_SCAN_DAY_OF_MONTH_OPTIONS.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs uppercase text-muted-foreground">
              {i18n.t(
                "policies:configurationPolicies.featureTabs.securityTab.dayOfWeek",
              )}
            </label>
            <select
              value={settings.scanDayOfWeek}
              onChange={(e) => update("scanDayOfWeek", e.target.value)}
              className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
            >
              {dayOfWeekOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Exclusions */}
      <div className="mt-6">
        <h3 className="text-sm font-semibold">
          {i18n.t(
            "policies:configurationPolicies.featureTabs.securityTab.exclusions",
          )}
        </h3>
        <p className="text-xs text-muted-foreground">
          {i18n.t(
            "policies:configurationPolicies.featureTabs.securityTab.skipTrustedLocationsDuringScans",
          )}
        </p>
        <div className="mt-3 flex gap-2">
          <input
            value={newExclusion}
            onChange={(e) => setNewExclusion(e.target.value)}
            onKeyDown={(e) =>
              e.key === "Enter" && (e.preventDefault(), handleAddExclusion())
            }
            placeholder={i18n.t(
              "policies:configurationPolicies.featureTabs.securityTab.addPathOrProcess",
            )}
            className="h-10 flex-1 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
          />
          <button
            type="button"
            onClick={handleAddExclusion}
            className="inline-flex items-center gap-1 rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted"
          >
            <Plus className="h-4 w-4" />
            {i18n.t("common:actions.add")}
          </button>
        </div>
        <div className="mt-3 space-y-2">
          {settings.exclusions.map((item) => (
            <div
              key={item}
              className="flex items-center justify-between rounded-md border bg-muted/30 px-3 py-2 text-sm"
            >
              <span className="truncate">{item}</span>
              <button
                type="button"
                onClick={() => handleRemoveExclusion(item)}
                className="rounded-md border p-1.5 hover:bg-muted"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      </div>
    </FeatureTabShell>
  );
}
