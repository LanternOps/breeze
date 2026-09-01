import { useState, useEffect } from "react";
import { Wrench } from "lucide-react";
import type { FeatureTabProps } from "./types";
import { FEATURE_META } from "./types";
import { useFeatureLink } from "./useFeatureLink";
import FeatureTabShell from "./FeatureTabShell";
import TimezoneSelect from "@/components/shared/TimezoneSelect";
import { useTranslation } from "react-i18next";
import { i18n } from "@/lib/i18n";
type MaintenanceSettings = {
  recurrence: "once" | "daily" | "weekly" | "monthly";
  durationHours: number;
  timezone: string;
  /**
   * When the window opens, in the configured timezone. Recurrence-discriminated:
   * an ISO-8601 local datetime for 'once' (e.g. "2026-03-15T02:00"), and an
   * "HH:MM" time of day for 'daily' / 'weekly' / 'monthly' (issue #4224).
   */
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
/** Anchor a recurring window inherits when nothing else is stored — matches the API fallback. */
const DEFAULT_START_TIME = "00:00";
// These three must stay in lockstep with `parseRecurringWindowAnchor` in
// apps/api/src/services/featureConfigResolver.ts — if the form and the
// evaluator disagree on a stored value, the UI shows one time and the window
// opens at another.
const TIME_OF_DAY_PATTERN = /^(\d{1,2}):(\d{2})(?::\d{2})?$/;
const DATETIME_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}[T ](\d{1,2}):(\d{2})/;
/** A trailing `Z` or `±HH:MM` offset — an instant, not local wall-clock time. */
const EXPLICIT_UTC_OFFSET_PATTERN = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/** Extracts an "HH:MM" time of day from either shape `windowStart` can hold. */
function toTimeOfDay(windowStart: string): string {
  // A datetime naming an instant cannot be read digit-for-digit as a time of
  // day in the policy's timezone — that would shift the window by the zone's
  // offset. Fall back to the visible default and let the admin choose.
  if (EXPLICIT_UTC_OFFSET_PATTERN.test(windowStart)) return DEFAULT_START_TIME;
  const match =
    TIME_OF_DAY_PATTERN.exec(windowStart) ??
    DATETIME_TIME_PATTERN.exec(windowStart);
  if (!match) return DEFAULT_START_TIME;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return DEFAULT_START_TIME;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/**
 * Keeps `windowStart` in the shape the current recurrence's control accepts.
 *
 * Both `<input type="time">` and `<input type="datetime-local">` silently
 * discard a value they cannot parse, so a cadence switch that left the other
 * shape behind would render a blank field and then save it — the exact
 * "no start time" outcome issue #4224 is about.
 */
function normalizeWindowStart(
  recurrence: MaintenanceSettings["recurrence"],
  windowStart: unknown,
): string {
  const raw = typeof windowStart === "string" ? windowStart.trim() : "";
  // A one-off window needs a date; a carried-over "HH:MM" cannot supply one,
  // so drop it and make the admin pick rather than saving an unusable value.
  if (recurrence === "once") return TIME_OF_DAY_PATTERN.test(raw) ? "" : raw;
  return toTimeOfDay(raw);
}

/**
 * Settings straight off a feature link may predate #4224 (`windowStart` null or
 * absent for a recurring cadence). Normalising on the way in makes the midnight
 * anchor the API has been applying all along visible in the form.
 */
function hydrate(raw: Partial<MaintenanceSettings>): MaintenanceSettings {
  const merged = { ...defaults, ...raw };
  return {
    ...merged,
    windowStart: normalizeWindowStart(merged.recurrence, merged.windowStart),
  };
}

/** Never persist a half-entered start time — a recurring window always gets a usable anchor. */
function toPayload(settings: MaintenanceSettings): MaintenanceSettings {
  return {
    ...settings,
    windowStart: normalizeWindowStart(settings.recurrence, settings.windowStart),
  };
}

const createRecurrenceOptions = () => [
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
  const recurrenceOptions = createRecurrenceOptions();
  const { save, remove, saving, error, clearError } = useFeatureLink(policyId);
  const isInherited = !!parentLink && !existingLink;
  const effectiveLink = existingLink ?? parentLink;
  const [settings, setSettings] = useState<MaintenanceSettings>(() =>
    hydrate({
      ...defaults,
      ...(effectiveLink?.inlineSettings as
        | Partial<MaintenanceSettings>
        | undefined),
    }),
  );
  useEffect(() => {
    const link = existingLink ?? parentLink;
    if (link?.inlineSettings) {
      setSettings((prev) =>
        hydrate({
          ...prev,
          ...(link.inlineSettings as Partial<MaintenanceSettings>),
        }),
      );
    }
  }, [existingLink, parentLink]);
  const update = <K extends keyof MaintenanceSettings>(
    key: K,
    value: MaintenanceSettings[K],
  ) => setSettings((prev) => ({ ...prev, [key]: value }));
  const changeRecurrence = (recurrence: MaintenanceSettings["recurrence"]) =>
    setSettings((prev) => ({
      ...prev,
      recurrence,
      windowStart: normalizeWindowStart(recurrence, prev.windowStart),
    }));
  const handleSave = async () => {
    clearError();
    const result = await save(existingLink?.id ?? null, {
      featureType: "maintenance",
      featurePolicyId: linkedPolicyId,
      inlineSettings: toPayload(settings),
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
      inlineSettings: toPayload(settings),
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
            data-testid="maintenance-recurrence"
            value={settings.recurrence}
            onChange={(e) =>
              changeRecurrence(
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

        {/* Window start — a full date/time for a one-off window, a time of day
            for the recurring cadences (issue #4224). */}
        {settings.recurrence === "once" ? (
          <div>
            <label
              htmlFor="maintenance-start-datetime"
              className="text-sm font-medium"
            >
              {i18n.t(
                "policies:configurationPolicies.featureTabs.maintenanceTab.startDateTime",
              )}
            </label>
            <input
              id="maintenance-start-datetime"
              data-testid="maintenance-start-datetime"
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
        ) : (
          <div>
            <label
              htmlFor="maintenance-start-time"
              className="text-sm font-medium"
            >
              {i18n.t(
                "policies:configurationPolicies.featureTabs.maintenanceTab.startTime",
              )}
            </label>
            <input
              id="maintenance-start-time"
              data-testid="maintenance-start-time"
              type="time"
              value={settings.windowStart}
              // Left as typed — a half-entered time reads as "" and snapping it
              // back to 00:00 here would fight the user mid-edit. `toPayload`
              // normalises on the way out instead.
              onChange={(e) => update("windowStart", e.target.value)}
              className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              {i18n.t(
                "policies:configurationPolicies.featureTabs.maintenanceTab.theTimeOfDayEachWindowOpensIn",
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
          <label htmlFor="maintenance-timezone" className="text-sm font-medium">
            {i18n.t(
              "policies:configurationPolicies.featureTabs.maintenanceTab.timezone",
            )}
          </label>
          <div className="mt-2">
            <TimezoneSelect
              id="maintenance-timezone"
              label={i18n.t(
                "policies:configurationPolicies.featureTabs.maintenanceTab.timezone",
              )}
              value={settings.timezone}
              onChange={(timezone) => update("timezone", timezone)}
              testId="maintenance-timezone"
            />
          </div>
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
