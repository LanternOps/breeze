import { useState, useEffect } from "react";
import { ShieldCheck, Plus, Trash2 } from "lucide-react";
import type { FeatureTabProps } from "./types";
import { FEATURE_META } from "./types";
import { useFeatureLink } from "./useFeatureLink";
import FeatureTabShell from "./FeatureTabShell";
import { useTranslation } from "react-i18next";
import { i18n } from "@/lib/i18n";
type SecuritySettings = {
  realTimeProtection: boolean;
  behavioralMonitoring: boolean;
  cloudLookup: boolean;
  scheduledScans: boolean;
  scanMinute: string;
  scanHour: string;
  scanDayOfMonth: string;
  scanDayOfWeek: string;
  autoQuarantine: boolean;
  notifyUser: boolean;
  blockUntrustedUsb: boolean;
  exclusions: string[];
};
const defaults: SecuritySettings = {
  realTimeProtection: true,
  behavioralMonitoring: true,
  cloudLookup: true,
  scheduledScans: true,
  scanMinute: "0",
  scanHour: "2",
  scanDayOfMonth: "*",
  scanDayOfWeek: "*",
  autoQuarantine: true,
  notifyUser: true,
  blockUntrustedUsb: false,
  exclusions: [],
};
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
const minuteOptions = ["0", "15", "30", "45"];
const hourOptions = ["0", "2", "6", "12", "18"];
const dayOfMonthOptions = ["*", "1", "15"];
const dayOfWeekOptions = [
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
export default function SecurityTab({
  policyId,
  existingLink,
  onLinkChanged,
  linkedPolicyId,
}: FeatureTabProps) {
  useTranslation("policies");
  const { save, remove, saving, error, clearError } = useFeatureLink(policyId);
  const [settings, setSettings] = useState<SecuritySettings>(() => {
    const stored = existingLink?.inlineSettings as
      | Partial<SecuritySettings>
      | undefined;
    const merged = { ...defaults, ...stored };
    if (!Array.isArray(merged.exclusions))
      merged.exclusions = [...defaults.exclusions];
    return merged;
  });
  const [newExclusion, setNewExclusion] = useState("");
  useEffect(() => {
    if (existingLink?.inlineSettings) {
      setSettings((prev) => {
        const merged = {
          ...prev,
          ...(existingLink.inlineSettings as Partial<SecuritySettings>),
        };
        if (!Array.isArray(merged.exclusions))
          merged.exclusions = [...defaults.exclusions];
        return merged;
      });
    }
  }, [existingLink]);
  const meta = FEATURE_META.security;
  const update = <K extends keyof SecuritySettings>(
    key: K,
    value: SecuritySettings[K],
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
      featurePolicyId: linkedPolicyId,
      inlineSettings: settings,
    });
    if (result) onLinkChanged(result, "security");
  };
  const handleRemove = async () => {
    if (!existingLink) return;
    const ok = await remove(existingLink.id);
    if (ok) onLinkChanged(null, "security");
  };
  return (
    <FeatureTabShell
      title={meta.label}
      description={meta.description}
      icon={<ShieldCheck className="h-5 w-5" />}
      isConfigured={!!existingLink}
      saving={saving}
      error={error}
      onSave={handleSave}
      onRemove={existingLink ? handleRemove : undefined}
    >
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Protection toggles */}
        <div className="space-y-3">
          <h3 className="text-sm font-semibold">
            {i18n.t(
              "policies:configurationPolicies.featureTabs.securityTab.realTimeProtection",
            )}
          </h3>
          <ToggleRow
            label={i18n.t(
              "policies:configurationPolicies.featureTabs.securityTab.realTimeFileMonitoring",
            )}
            description={i18n.t(
              "policies:configurationPolicies.featureTabs.securityTab.scanNewAndModifiedFilesContinuously",
            )}
            checked={settings.realTimeProtection}
            onChange={(v) =>
              update(
                i18n.t(
                  "policies:configurationPolicies.featureTabs.securityTab.realTimeProtection2",
                ),
                v,
              )
            }
          />
          <ToggleRow
            label={i18n.t(
              "policies:configurationPolicies.featureTabs.securityTab.behavioralMonitoring",
            )}
            description={i18n.t(
              "policies:configurationPolicies.featureTabs.securityTab.detectSuspiciousProcessBehaviorAndScripts",
            )}
            checked={settings.behavioralMonitoring}
            onChange={(v) =>
              update(
                i18n.t(
                  "policies:configurationPolicies.featureTabs.securityTab.behavioralMonitoring2",
                ),
                v,
              )
            }
          />
          <ToggleRow
            label={i18n.t(
              "policies:configurationPolicies.featureTabs.securityTab.cloudThreatLookup",
            )}
            description={i18n.t(
              "policies:configurationPolicies.featureTabs.securityTab.useCloudReputationForNewIndicators",
            )}
            checked={settings.cloudLookup}
            onChange={(v) =>
              update(
                i18n.t(
                  "policies:configurationPolicies.featureTabs.securityTab.cloudLookup",
                ),
                v,
              )
            }
          />
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
            onChange={(v) =>
              update(
                i18n.t(
                  "policies:configurationPolicies.featureTabs.securityTab.autoQuarantine2",
                ),
                v,
              )
            }
          />
          <ToggleRow
            label={i18n.t(
              "policies:configurationPolicies.featureTabs.securityTab.notifyUserOnDetection",
            )}
            description={i18n.t(
              "policies:configurationPolicies.featureTabs.securityTab.sendDeviceNotificationsWhenThreatsAreFound",
            )}
            checked={settings.notifyUser}
            onChange={(v) =>
              update(
                i18n.t(
                  "policies:configurationPolicies.featureTabs.securityTab.notifyUser",
                ),
                v,
              )
            }
          />
          <ToggleRow
            label={i18n.t(
              "policies:configurationPolicies.featureTabs.securityTab.blockUntrustedUSBDevices",
            )}
            description={i18n.t(
              "policies:configurationPolicies.featureTabs.securityTab.preventUnknownRemovableMedia",
            )}
            checked={settings.blockUntrustedUsb}
            onChange={(v) =>
              update(
                i18n.t(
                  "policies:configurationPolicies.featureTabs.securityTab.blockUntrustedUsb",
                ),
                v,
              )
            }
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
            onClick={() =>
              update(
                i18n.t(
                  "policies:configurationPolicies.featureTabs.securityTab.scheduledScans2",
                ),
                !settings.scheduledScans,
              )
            }
            className={`rounded-full border px-3 py-1 text-xs font-semibold ${settings.scheduledScans ? "bg-emerald-500/15 text-emerald-700" : "bg-muted text-muted-foreground"}`}
          >
            {settings.scheduledScans
              ? i18n.t("common:states.enabled")
              : i18n.t("common:states.disabled")}
          </button>
        </div>
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
              onChange={(e) =>
                update(
                  i18n.t(
                    "policies:configurationPolicies.featureTabs.securityTab.scanMinute",
                  ),
                  e.target.value,
                )
              }
              className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
            >
              {minuteOptions.map((o) => (
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
              onChange={(e) =>
                update(
                  i18n.t(
                    "policies:configurationPolicies.featureTabs.securityTab.scanHour",
                  ),
                  e.target.value,
                )
              }
              className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
            >
              {hourOptions.map((o) => (
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
              onChange={(e) =>
                update(
                  i18n.t(
                    "policies:configurationPolicies.featureTabs.securityTab.scanDayOfMonth",
                  ),
                  e.target.value,
                )
              }
              className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
            >
              {dayOfMonthOptions.map((o) => (
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
              onChange={(e) =>
                update(
                  i18n.t(
                    "policies:configurationPolicies.featureTabs.securityTab.scanDayOfWeek",
                  ),
                  e.target.value,
                )
              }
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
              e.key ===
                i18n.t(
                  "policies:configurationPolicies.featureTabs.securityTab.enter",
                ) && (e.preventDefault(), handleAddExclusion())
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
