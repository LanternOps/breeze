import { useState, useEffect } from "react";
import { Trash2 } from "lucide-react";
import type { FeatureTabProps } from "./types";
import { FEATURE_META } from "./types";
import { useFeatureLink } from "./useFeatureLink";
import FeatureTabShell from "./FeatureTabShell";
import { useTranslation } from "react-i18next";
import { i18n } from "@/lib/i18n";

/**
 * `device_lifecycle` — "permanently delete removed devices N days after
 * removal" (#2787 item 4).
 *
 * The stored setting is three-valued: absent / null means never purge, a
 * number 1..3650 is the window. This tab models that as a toggle plus a number,
 * and deliberately DEFAULTS TO OFF — adding the feature to a policy must never
 * start deleting devices on its own.
 *
 * The day input is validated client-side against the same 1..3650 bound the
 * shared validator enforces, not to save a round trip but because a `0` here
 * would read as "delete every removed device on the next run" and must not be
 * expressible at all.
 */
type DeviceLifecycleSettings = {
  purgeRemovedAfterDays: number | null;
};

/** Offered when the operator switches purging on without typing a window. */
const DEFAULT_WINDOW_DAYS = 30;
const MIN_DAYS = 1;
const MAX_DAYS = 3650;

function readStoredDays(inlineSettings: Record<string, unknown> | null | undefined): number | null {
  const raw = inlineSettings?.purgeRemovedAfterDays;
  return typeof raw === "number" && Number.isInteger(raw) ? raw : null;
}

export default function DeviceLifecycleTab({
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

  const storedDays = readStoredDays(effectiveLink?.inlineSettings);
  const [enabled, setEnabled] = useState<boolean>(storedDays !== null);
  // Kept as a string so a half-typed or emptied field is representable and can
  // be reported, rather than silently coerced to a number that then gets saved.
  const [daysInput, setDaysInput] = useState<string>(String(storedDays ?? DEFAULT_WINDOW_DAYS));

  useEffect(() => {
    const link = existingLink ?? parentLink;
    const days = readStoredDays(link?.inlineSettings);
    setEnabled(days !== null);
    if (days !== null) setDaysInput(String(days));
  }, [existingLink, parentLink]);

  const parsedDays = Number(daysInput);
  const daysValid =
    daysInput.trim() !== "" &&
    Number.isInteger(parsedDays) &&
    parsedDays >= MIN_DAYS &&
    parsedDays <= MAX_DAYS;
  const invalid = enabled && !daysValid;

  const settings = (): DeviceLifecycleSettings => ({
    purgeRemovedAfterDays: enabled && daysValid ? parsedDays : null,
  });

  const handleSave = async () => {
    if (invalid) return;
    clearError();
    const result = await save(existingLink?.id ?? null, {
      featureType: "device_lifecycle",
      featurePolicyId: linkedPolicyId,
      inlineSettings: settings(),
    });
    if (result) onLinkChanged(result, "device_lifecycle");
  };

  const handleRemove = async () => {
    if (!existingLink) return;
    const ok = await remove(existingLink.id);
    if (ok) onLinkChanged(null, "device_lifecycle");
  };

  const handleOverride = async () => {
    if (invalid) return;
    clearError();
    const result = await save(null, {
      featureType: "device_lifecycle",
      featurePolicyId: linkedPolicyId,
      inlineSettings: settings(),
    });
    if (result) onLinkChanged(result, "device_lifecycle");
  };

  const handleRevert = async () => {
    if (!existingLink) return;
    const ok = await remove(existingLink.id);
    if (ok) onLinkChanged(null, "device_lifecycle");
  };

  const meta = FEATURE_META.device_lifecycle;

  return (
    <FeatureTabShell
      title={meta.label}
      description={meta.description}
      icon={<Trash2 className="h-5 w-5" />}
      isConfigured={!!existingLink || isInherited}
      configuredButInactive={!enabled}
      saving={saving}
      saveDisabled={invalid}
      error={error}
      onSave={handleSave}
      onRemove={existingLink && !linkedPolicyId ? handleRemove : undefined}
      isInherited={isInherited}
      onOverride={isInherited ? handleOverride : undefined}
      onRevert={
        !isInherited && !!linkedPolicyId && !!existingLink ? handleRevert : undefined
      }
    >
      <div className="space-y-6">
        <div className="flex items-center justify-between rounded-md border bg-background px-4 py-3">
          <div>
            <p className="text-sm font-medium">
              {i18n.t(
                "policies:configurationPolicies.featureTabs.deviceLifecycleTab.permanentlyDeleteRemovedDevices",
              )}
            </p>
            {/* The hint follows the TOGGLE, not the saved link: it used to be
                hard-coded to the Off sentence, so a policy purging after 30
                days still read "Off — keep removed devices until someone
                deletes them manually" directly above the window it was about
                to enforce. While the typed window is invalid neither sentence
                is true, so the field's own inline error is the message. */}
            {(!enabled || daysValid) && (
              <p
                data-testid="device-lifecycle-tab-mode-hint"
                className="text-xs text-muted-foreground"
              >
                {enabled
                  ? i18n.t(
                      "policies:configurationPolicies.featureTabs.deviceLifecycleTab.removedDevicesArePermanentlyDeletedAfterDays",
                      { days: parsedDays },
                    )
                  : i18n.t(
                      "policies:configurationPolicies.featureTabs.deviceLifecycleTab.offKeepRemovedDevicesUntilDeletedManually",
                    )}
              </p>
            )}
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            data-testid="device-lifecycle-tab-enabled-toggle"
            onClick={() => setEnabled((prev) => !prev)}
            className={`relative inline-flex h-6 w-11 items-center rounded-full border transition ${enabled ? "bg-red-500/80" : "bg-muted"}`}
          >
            <span
              className={`inline-block h-5 w-5 rounded-full bg-white transition ${enabled ? "translate-x-5" : "translate-x-1"}`}
            />
          </button>
        </div>

        {enabled && (
          <div className="rounded-md border bg-background px-4 py-3">
            <label
              htmlFor="device-lifecycle-days"
              className="text-sm font-medium"
            >
              {i18n.t(
                "policies:configurationPolicies.featureTabs.deviceLifecycleTab.permanentlyDeleteRemovedDevicesAfter",
              )}
            </label>
            <div className="mt-2 flex items-center gap-2">
              <input
                id="device-lifecycle-days"
                data-testid="device-lifecycle-tab-days"
                type="number"
                min={MIN_DAYS}
                max={MAX_DAYS}
                step={1}
                value={daysInput}
                onChange={(e) => setDaysInput(e.target.value)}
                className="w-28 rounded-md border bg-background px-3 py-2 text-sm"
              />
              <span className="text-sm text-muted-foreground">
                {i18n.t(
                  "policies:configurationPolicies.featureTabs.deviceLifecycleTab.days",
                )}
              </span>
            </div>
            {invalid && (
              <p
                data-testid="device-lifecycle-tab-days-error"
                className="mt-2 text-xs text-red-600"
              >
                {i18n.t(
                  "policies:configurationPolicies.featureTabs.deviceLifecycleTab.enterAWholeNumberOfDaysBetween",
                )}
              </p>
            )}
          </div>
        )}

        <div
          data-testid="device-lifecycle-tab-warning"
          className="rounded-md border border-red-500/40 bg-red-500/10 px-4 py-3"
        >
          <p className="text-sm font-medium text-red-700">
            {i18n.t(
              "policies:configurationPolicies.featureTabs.deviceLifecycleTab.purgeIsIrreversibleAndDestroysHistory",
            )}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {i18n.t(
              "policies:configurationPolicies.featureTabs.deviceLifecycleTab.aDailyJobPermanentlyDeletesTheDevice",
            )}
          </p>
        </div>
      </div>
    </FeatureTabShell>
  );
}
