import { useState, useEffect } from "react";
import { Wrench } from "lucide-react";
import type { FeatureTabProps } from "./types";
import { FEATURE_META } from "./types";
import { useFeatureLink } from "./useFeatureLink";
import FeatureTabShell from "./FeatureTabShell";
import { useTranslation } from "react-i18next";
import { i18n } from "@/lib/i18n";
type MaintenanceSettings = {
  recurrence: "once" | "daily" | "weekly" | "monthly";
  durationHours: number;
  timezone: string;
  /** ISO-8601 local datetime for 'once' recurrence (e.g. "2026-03-15T02:00"). Only used when recurrence is 'once'. */
  windowStart: string;
  suppressAlerts: boolean;
  suppressPatching: boolean;
  suppressAutomations: boolean;
  suppressScripts: boolean;
  rebootIfPending: boolean;
  notifyBeforeMinutes: number;
  notifyOnStart: boolean;
  notifyOnEnd: boolean;
};
const defaults: MaintenanceSettings = {
  recurrence: "weekly",
  durationHours: 2,
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  windowStart: "",
  suppressAlerts: true,
  suppressPatching: false,
  suppressAutomations: false,
  suppressScripts: false,
  rebootIfPending: false,
  notifyBeforeMinutes: 15,
  notifyOnStart: true,
  notifyOnEnd: true,
};
const recurrenceOptions = [
  {
    value: "once",
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.maintenanceTab.once",
    ),
  },
  {
    value: "daily",
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.maintenanceTab.daily",
    ),
  },
  {
    value: "weekly",
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.maintenanceTab.weekly",
    ),
  },
  {
    value: "monthly",
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.maintenanceTab.monthly",
    ),
  },
];
const timezoneOptions = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Phoenix",
  "America/Anchorage",
  "Pacific/Honolulu",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Paris",
  "Asia/Tokyo",
  "Asia/Shanghai",
  "Asia/Kolkata",
  "Australia/Sydney",
  "UTC",
];
function ToggleRow({
  label,
  description,
  checked,
  onChange,
  testId,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  testId?: string;
}) {
  return (
    <div className="flex items-center justify-between rounded-md border bg-background px-4 py-3">
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <button
        type="button"
        data-testid={testId}
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
export default function MaintenanceTab({
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
  const [settings, setSettings] = useState<MaintenanceSettings>(() => ({
    ...defaults,
    ...(effectiveLink?.inlineSettings as
      | Partial<MaintenanceSettings>
      | undefined),
  }));
  useEffect(() => {
    const link = existingLink ?? parentLink;
    if (link?.inlineSettings) {
      setSettings((prev) => ({
        ...prev,
        ...(link.inlineSettings as Partial<MaintenanceSettings>),
      }));
    }
  }, [existingLink, parentLink]);
  const update = <K extends keyof MaintenanceSettings>(
    key: K,
    value: MaintenanceSettings[K],
  ) => setSettings((prev) => ({ ...prev, [key]: value }));
  const handleSave = async () => {
    clearError();
    const result = await save(existingLink?.id ?? null, {
      featureType: "maintenance",
      featurePolicyId: linkedPolicyId,
      inlineSettings: settings,
    });
    if (result) onLinkChanged(result, "maintenance");
  };
  const handleRemove = async () => {
    if (!existingLink) return;
    const ok = await remove(existingLink.id);
    if (ok) onLinkChanged(null, "maintenance");
  };
  const handleOverride = async () => {
    clearError();
    const result = await save(null, {
      featureType: "maintenance",
      featurePolicyId: linkedPolicyId,
      inlineSettings: settings,
    });
    if (result) onLinkChanged(result, "maintenance");
  };
  const handleRevert = async () => {
    if (!existingLink) return;
    const ok = await remove(existingLink.id);
    if (ok) onLinkChanged(null, "maintenance");
  };
  const meta = FEATURE_META.maintenance;
  return (
    <FeatureTabShell
      title={meta.label}
      description={meta.description}
      icon={<Wrench className="h-5 w-5" />}
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
      <div className="grid gap-6 sm:grid-cols-2">
        {/* Recurrence */}
        <div>
          <label className="text-sm font-medium">
            {i18n.t(
              "policies:configurationPolicies.featureTabs.maintenanceTab.recurrence",
            )}
          </label>
          <select
            value={settings.recurrence}
            onChange={(e) =>
              update(
                "recurrence",
                e.target.value as MaintenanceSettings["recurrence"],
              )
            }
            className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
          >
            {recurrenceOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        {/* Window Start (only for 'once' recurrence) */}
        {settings.recurrence === "once" && (
          <div>
            <label className="text-sm font-medium">
              {i18n.t(
                "policies:configurationPolicies.featureTabs.maintenanceTab.startDateTime",
              )}
            </label>
            <input
              type="datetime-local"
              value={settings.windowStart}
              onChange={(e) => update("windowStart", e.target.value)}
              className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              {i18n.t(
                "policies:configurationPolicies.featureTabs.maintenanceTab.theSpecificDateAndTimeForThis",
              )}
            </p>
          </div>
        )}

        {/* Duration */}
        <div>
          <label className="text-sm font-medium">
            {i18n.t(
              "policies:configurationPolicies.featureTabs.maintenanceTab.durationHours",
            )}
          </label>
          <input
            type="number"
            min={1}
            max={72}
            value={settings.durationHours}
            onChange={(e) =>
              update("durationHours", Number(e.target.value) || 1)
            }
            className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
          />
        </div>

        {/* Timezone */}
        <div>
          <label className="text-sm font-medium">
            {i18n.t(
              "policies:configurationPolicies.featureTabs.maintenanceTab.timezone",
            )}
          </label>
          <select
            value={settings.timezone}
            onChange={(e) => update("timezone", e.target.value)}
            className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
          >
            {timezoneOptions.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </select>
        </div>

        {/* Notify before */}
        <div>
          <label className="text-sm font-medium">
            {i18n.t(
              "policies:configurationPolicies.featureTabs.maintenanceTab.notifyBeforeMinutes",
            )}
          </label>
          <input
            type="number"
            min={0}
            max={1440}
            value={settings.notifyBeforeMinutes}
            onChange={(e) =>
              update("notifyBeforeMinutes", Number(e.target.value) || 0)
            }
            className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
          />
        </div>
      </div>

      {/* Suppression toggles */}
      <div className="mt-6 space-y-3">
        <h3 className="text-sm font-semibold">
          {i18n.t(
            "policies:configurationPolicies.featureTabs.maintenanceTab.suppressionDuringWindow",
          )}
        </h3>
        <ToggleRow
          label={i18n.t(
            "policies:configurationPolicies.featureTabs.maintenanceTab.suppressAlerts",
          )}
          description={i18n.t(
            "policies:configurationPolicies.featureTabs.maintenanceTab.muteAlertNotificationsDuringWindow",
          )}
          checked={settings.suppressAlerts}
          onChange={(v) => update("suppressAlerts", v)}
        />
        <ToggleRow
          label={i18n.t(
            "policies:configurationPolicies.featureTabs.maintenanceTab.suppressPatching",
          )}
          description={i18n.t(
            "policies:configurationPolicies.featureTabs.maintenanceTab.delayPatchInstallationsDuringWindow",
          )}
          checked={settings.suppressPatching}
          onChange={(v) => update("suppressPatching", v)}
        />
        <ToggleRow
          label={i18n.t(
            "policies:configurationPolicies.featureTabs.maintenanceTab.suppressAutomations",
          )}
          description={i18n.t(
            "policies:configurationPolicies.featureTabs.maintenanceTab.pauseAutomationRunsDuringWindow",
          )}
          checked={settings.suppressAutomations}
          onChange={(v) => update("suppressAutomations", v)}
        />
        <ToggleRow
          label={i18n.t(
            "policies:configurationPolicies.featureTabs.maintenanceTab.suppressScripts",
          )}
          description={i18n.t(
            "policies:configurationPolicies.featureTabs.maintenanceTab.pauseScriptExecutionDuringWindow",
          )}
          checked={settings.suppressScripts}
          onChange={(v) => update("suppressScripts", v)}
        />
      </div>

      {/* Actions during window */}
      <div className="mt-6 space-y-3">
        <h3 className="text-sm font-semibold">
          {i18n.t(
            "policies:configurationPolicies.featureTabs.maintenanceTab.actionsDuringWindow",
          )}
        </h3>
        <ToggleRow
          label={i18n.t(
            "policies:configurationPolicies.featureTabs.maintenanceTab.rebootIfARebootIsPending",
          )}
          description={i18n.t(
            "policies:configurationPolicies.featureTabs.maintenanceTab.duringTheWindowRebootDevicesThatHave",
          )}
          checked={settings.rebootIfPending}
          onChange={(v) => update("rebootIfPending", v)}
          testId={i18n.t(
            "policies:configurationPolicies.featureTabs.maintenanceTab.maintenanceRebootIfPendingToggle",
          )}
        />
      </div>

      {/* Notification toggles */}
      <div className="mt-6 space-y-3">
        <h3 className="text-sm font-semibold">
          {i18n.t(
            "policies:configurationPolicies.featureTabs.maintenanceTab.notifications",
          )}
        </h3>
        <ToggleRow
          label={i18n.t(
            "policies:configurationPolicies.featureTabs.maintenanceTab.notifyOnStart",
          )}
          description={i18n.t(
            "policies:configurationPolicies.featureTabs.maintenanceTab.sendNotificationWhenWindowOpens",
          )}
          checked={settings.notifyOnStart}
          onChange={(v) => update("notifyOnStart", v)}
        />
        <ToggleRow
          label={i18n.t(
            "policies:configurationPolicies.featureTabs.maintenanceTab.notifyOnEnd",
          )}
          description={i18n.t(
            "policies:configurationPolicies.featureTabs.maintenanceTab.sendNotificationWhenWindowCloses",
          )}
          checked={settings.notifyOnEnd}
          onChange={(v) => update("notifyOnEnd", v)}
        />
      </div>
    </FeatureTabShell>
  );
}
