import { useState, useEffect, useCallback } from "react";
import { PackageCheck, Loader2, Plus, Pencil } from "lucide-react";
import { cn } from "@/lib/utils";
import type { FeatureTabProps } from "./types";
import { FEATURE_META } from "./types";
import { useFeatureLink } from "./useFeatureLink";
import FeatureTabShell from "./FeatureTabShell";
import { fetchWithAuth } from "../../../stores/auth";
import type { RingAppRule } from "../../patches/RingAppRulesSection";
import { extractApiError } from "@/lib/apiError";
import { Dialog } from "../../shared/Dialog";
import UpdateRingForm, {
  type UpdateRingFormValues,
} from "../../patches/UpdateRingForm";
import type { UpdateRingItem as UpdateRing } from "../../patches/UpdateRingList";
import { normalizeRing } from "../../patches/patchHelpers";
import { showToast } from "../../shared/Toast";
import { useTranslation } from "react-i18next";
import { i18n } from "@/lib/i18n";
import {
  rebootPromptTextSchemas,
  REBOOT_PROMPT_TITLE_MAX,
  REBOOT_PROMPT_BODY_MAX,
  REBOOT_PROMPT_BUTTON_MAX,
  REBOOT_PROMPT_COUNTDOWN_PLACEHOLDER,
} from "@breeze/shared";
type ScheduleFrequency = "daily" | "weekly" | "monthly";
type RebootPolicy = "never" | "if_required" | "always" | "maintenance_window";
/** #5128 W3 — what a scheduled install does when the device is offline. */
type OfflineBehavior = "skip" | "queue";
type PatchSourceOption = "os" | "third_party";
// #8187: no approval keys (`autoApprove*`, `apps`). The Update Ring owns them,
// and the API judges any sent one as an attempt to edit ring-owned rules
// (400 APPROVAL_RULES_MOVED_TO_RING), so the tab neither holds nor sends them.
type PatchDeploymentSettings = {
  sources: PatchSourceOption[];
  scheduleFrequency: ScheduleFrequency;
  scheduleTime: string;
  scheduleDayOfWeek: string;
  scheduleDayOfMonth: number;
  offlineBehavior: OfflineBehavior;
  rebootPolicy: RebootPolicy;
  rebootDelayMinutes: number;
  // #3207: end-user reboot deferral budget. Off by default.
  rebootAllowDeferral: boolean;
  rebootMaxDeferrals: number;
  rebootDeferralMinutes: number;
  // #8030: optional end-user restart-prompt text. null keeps the agent's
  // built-in copy; `{{countdown}}` is filled in by the agent.
  rebootPromptTitle: string | null;
  rebootPromptBody: string | null;
  rebootPromptButton: string | null;
  exclusiveWindowsUpdate: boolean;
};
const defaults: PatchDeploymentSettings = {
  sources: ["os"],
  scheduleFrequency: "weekly",
  scheduleTime: "02:00",
  scheduleDayOfWeek: "sun",
  scheduleDayOfMonth: 1,
  offlineBehavior: "queue",
  rebootPolicy: "if_required",
  rebootDelayMinutes: 15,
  rebootAllowDeferral: false,
  rebootMaxDeferrals: 3,
  rebootDeferralMinutes: 60,
  rebootPromptTitle: null,
  rebootPromptBody: null,
  rebootPromptButton: null,
  exclusiveWindowsUpdate: false,
};
/** Keys a link may still store from before the Update Ring owned approval (#8187). */
const RING_OWNED_APPROVAL_KEYS = new Set([
  "apps",
  "autoApprove",
  "autoApproveSeverities",
  "autoApproveDeferralDays",
]);
/** The link's stored settings as tab state, minus the ring-owned approval keys. */
function settingsFromInline(
  inline: Record<string, unknown> | null | undefined,
): Partial<PatchDeploymentSettings> {
  const kept = Object.fromEntries(
    Object.entries(inline ?? {}).filter(([key]) => !RING_OWNED_APPROVAL_KEYS.has(key)),
  ) as Partial<PatchDeploymentSettings>;
  return { ...kept, sources: normalizeSources(kept.sources) };
}
/** The legacy app rules a link still stores (W04 strips them), for the repair prompt. */
function legacyAppRules(inline: Record<string, unknown> | null | undefined): RingAppRule[] {
  const apps = inline?.apps;
  return Array.isArray(apps)
    ? apps.filter(
        (rule): rule is RingAppRule =>
          !!rule && typeof rule === "object" && typeof (rule as RingAppRule).packageId === "string",
      )
    : [];
}
/** Blank input means "use the built-in text", stored as null. */
function promptTextOrNull(value: string): string | null {
  return value.trim() === "" ? null : value;
}
const OS_VALUE_ALIASES = new Set(["os", "microsoft", "apple", "linux"]);
const THIRD_PARTY_VALUE_ALIASES = new Set(["third_party", "custom"]);
function normalizeSources(raw: unknown): PatchSourceOption[] {
  if (!Array.isArray(raw)) return ["os"];
  const result: PatchSourceOption[] = [];
  if (raw.some((s) => typeof s === "string" && OS_VALUE_ALIASES.has(s)))
    result.push("os");
  if (
    raw.some((s) => typeof s === "string" && THIRD_PARTY_VALUE_ALIASES.has(s))
  )
    result.push("third_party");
  return result.length > 0 ? result : ["os"];
}
const createScheduleOptions = (): {
  value: ScheduleFrequency;
  label: string;
}[] => [
  {
    value: "daily",
    label: i18n.t("policies:configurationPolicies.featureTabs.patchTab.daily"),
  },
  {
    value: "weekly",
    label: i18n.t("policies:configurationPolicies.featureTabs.patchTab.weekly"),
  },
  {
    value: "monthly",
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.patchTab.monthly",
    ),
  },
];
const createRebootOptions = (): {
  value: RebootPolicy;
  label: string;
  description: string;
}[] => [
  {
    value: "never",
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.patchTab.neverReboot",
    ),
    description: i18n.t(
      "policies:configurationPolicies.featureTabs.patchTab.doNotRebootDevicesAutomatically",
    ),
  },
  {
    value: "if_required",
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.patchTab.ifRequired",
    ),
    description: i18n.t(
      "policies:configurationPolicies.featureTabs.patchTab.rebootOnlyWhenThePatchRequiresIt",
    ),
  },
  {
    value: "always",
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.patchTab.alwaysReboot",
    ),
    description: i18n.t(
      "policies:configurationPolicies.featureTabs.patchTab.alwaysRebootAfterPatching",
    ),
  },
  {
    value: "maintenance_window",
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.patchTab.duringMaintenanceWindow",
    ),
    description: i18n.t(
      "policies:configurationPolicies.featureTabs.patchTab.onlyRebootDuringAScheduledMaintenanceWindow",
    ),
  },
];
const createOfflineBehaviorOptions = (): {
  value: OfflineBehavior;
  label: string;
  description: string;
}[] => [
  {
    value: "queue",
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.patchTab.offlineBehaviorQueue",
    ),
    description: i18n.t(
      "policies:configurationPolicies.featureTabs.patchTab.offlineBehaviorQueueDescription",
    ),
  },
  {
    value: "skip",
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.patchTab.offlineBehaviorSkip",
    ),
    description: i18n.t(
      "policies:configurationPolicies.featureTabs.patchTab.offlineBehaviorSkipDescription",
    ),
  },
];
const createDayOfWeekOptions = () => [
  {
    value: "mon",
    label: i18n.t("policies:configurationPolicies.featureTabs.patchTab.monday"),
  },
  {
    value: "tue",
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.patchTab.tuesday",
    ),
  },
  {
    value: "wed",
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.patchTab.wednesday",
    ),
  },
  {
    value: "thu",
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.patchTab.thursday",
    ),
  },
  {
    value: "fri",
    label: i18n.t("policies:configurationPolicies.featureTabs.patchTab.friday"),
  },
  {
    value: "sat",
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.patchTab.saturday",
    ),
  },
  {
    value: "sun",
    label: i18n.t("policies:configurationPolicies.featureTabs.patchTab.sunday"),
  },
];
export default function PatchTab({
  policyId,
  existingLink,
  onLinkChanged,
  linkedPolicyId,
  parentLink,
}: FeatureTabProps) {
  useTranslation("policies");
  const scheduleOptions = createScheduleOptions();
  const rebootOptions = createRebootOptions();
  const offlineBehaviorOptions = createOfflineBehaviorOptions();
  const dayOfWeekOptions = createDayOfWeekOptions();
  const { save, remove, saving, error, clearError } = useFeatureLink(policyId);
  const isInherited = !!parentLink && !existingLink;
  const effectiveLink = existingLink ?? parentLink;
  const [selectedRingId, setSelectedRingId] = useState<string>(
    () => effectiveLink?.featurePolicyId ?? "",
  );
  const [rings, setRings] = useState<UpdateRing[]>([]);
  const [ringsLoading, setRingsLoading] = useState(false);
  // Only a successful load can say a linked ring is missing from the list.
  const [ringsLoaded, setRingsLoaded] = useState(false);
  const [ringsError, setRingsError] = useState<string>();
  const [settings, setSettings] = useState<PatchDeploymentSettings>(() => ({
    ...defaults,
    ...settingsFromInline(effectiveLink?.inlineSettings),
  }));
  const [validationError, setValidationError] = useState<string>();
  const [promptError, setPromptError] = useState<string>();
  // Inline ring create/edit — the same editor as /patches, so an admin never
  // has to leave the policy to author the ring it links to.
  const [ringEditorOpen, setRingEditorOpen] = useState(false);
  const [ringEditorMode, setRingEditorMode] = useState<"create" | "edit">(
    "create",
  );
  const [ringSubmitting, setRingSubmitting] = useState(false);
  const [ringEditorError, setRingEditorError] = useState<string>();
  const fetchRings = useCallback(async () => {
    setRingsLoading(true);
    setRingsError(undefined);
    // A stale list must not mark a linked (or just-created) ring unavailable.
    setRingsLoaded(false);
    try {
      const response = await fetchWithAuth("/update-rings");
      // fetchWithAuth doesn't throw on 4xx/5xx — without this the picker would
      // silently show an empty list (indistinguishable from "no rings") and a
      // linked ring would blank out.
      if (!response.ok)
        throw new Error(
          i18n.t(
            "policies:configurationPolicies.featureTabs.patchTab.failedToLoadUpdateRings",
          ),
        );
      const payload = await response.json();
      const raw = Array.isArray(payload.data)
        ? payload.data
        : Array.isArray(payload)
          ? payload
          : [];
      // Normalize so the form hydrates with typed defaults (a ring whose
      // auto_approve JSONB is `{}` — the DB default / pre-#1317 rows — would
      // otherwise fail the editor's zod validation and silently refuse to save).
      setRings(raw.map((r: Record<string, unknown>) => normalizeRing(r)));
      setRingsLoaded(true);
    } catch (err) {
      setRingsError(
        err instanceof Error ? err.message : "Failed to load update rings",
      );
    } finally {
      setRingsLoading(false);
    }
  }, []);
  useEffect(() => {
    fetchRings();
  }, [fetchRings]);
  useEffect(() => {
    const link = existingLink ?? parentLink;
    if (link?.featurePolicyId) {
      setSelectedRingId(link.featurePolicyId);
    }
    if (link?.inlineSettings) {
      const inline = link.inlineSettings;
      setSettings((prev) => ({ ...prev, ...settingsFromInline(inline) }));
    }
  }, [existingLink, parentLink]);
  const update = <K extends keyof PatchDeploymentSettings>(
    key: K,
    value: PatchDeploymentSettings[K],
  ) => setSettings((prev) => ({ ...prev, [key]: value }));
  // Client-side mirror of the server-side Zod checks so users get inline
  // feedback instead of a round-trip rejection.
  // #8030: same schema the API applies, so plain-text / length / placeholder
  // problems surface before the save rather than as a rejected one. Checked
  // whatever the reboot policy: the fields are hidden under "never" but are
  // still sent, and the server validates them either way.
  const validatePromptText = (): string | null => {
    const valid =
      rebootPromptTextSchemas.title.safeParse(settings.rebootPromptTitle)
        .success &&
      rebootPromptTextSchemas.body.safeParse(settings.rebootPromptBody)
        .success &&
      rebootPromptTextSchemas.button.safeParse(settings.rebootPromptButton)
        .success;
    return valid
      ? null
      : i18n.t(
          "policies:configurationPolicies.featureTabs.patchTab.rebootPromptInvalid",
          { placeholder: REBOOT_PROMPT_COUNTDOWN_PLACEHOLDER },
        );
  };
  /**
   * Every pre-save check. Returns the banner message, "" when the only problem
   * is already shown inline next to the prompt-text fields (so it is not shown
   * twice), or null when the save may proceed.
   */
  const validateBeforeSave = (): string | null => {
    const promptMessage = validatePromptText();
    const promptFieldsVisible = settings.rebootPolicy !== "never";
    setPromptError(
      promptMessage && promptFieldsVisible ? promptMessage : undefined,
    );
    if (promptMessage) return promptFieldsVisible ? "" : promptMessage;
    return null;
  };
  const handleSave = async () => {
    clearError();
    const validation = validateBeforeSave();
    setValidationError(validation ?? undefined);
    if (validation !== null) return;
    const result = await save(existingLink?.id ?? null, {
      featureType: "patch",
      featurePolicyId: selectedRingId || null,
      inlineSettings: settings,
    });
    // The save POST returned 201 with no UI feedback before — confirm success
    // (the hook surfaces failures via `error` → FeatureTabShell).
    if (result) {
      showToast({
        message: i18n.t(
          "policies:configurationPolicies.featureTabs.patchTab.patchSettingsSaved",
        ),
        type: "success",
      });
      onLinkChanged(result, "patch");
    }
  };
  const handleRemove = async () => {
    if (!existingLink) return;
    const ok = await remove(existingLink.id, { successMessage: null });
    if (ok) {
      showToast({
        message: i18n.t(
          "policies:configurationPolicies.featureTabs.patchTab.patchSettingsRemoved",
        ),
        type: "success",
      });
      onLinkChanged(null, "patch");
    }
  };
  const handleOverride = async () => {
    clearError();
    const validation = validateBeforeSave();
    setValidationError(validation ?? undefined);
    if (validation !== null) return;
    const result = await save(null, {
      featureType: "patch",
      featurePolicyId: selectedRingId || null,
      inlineSettings: settings,
    });
    if (result) {
      showToast({
        message: i18n.t(
          "policies:configurationPolicies.featureTabs.patchTab.patchSettingsOverridden",
        ),
        type: "success",
      });
      onLinkChanged(result, "patch");
    }
  };
  const handleRevert = async () => {
    if (!existingLink) return;
    const ok = await remove(existingLink.id, { successMessage: null });
    if (ok) {
      showToast({
        message: i18n.t(
          "policies:configurationPolicies.featureTabs.patchTab.revertedToInheritedPatchSettings",
        ),
        type: "success",
      });
      onLinkChanged(null, "patch");
    }
  };
  const selectedRing = rings.find((r) => r.id === selectedRingId);
  // #8186: a link whose ring vanished, was never valid, or belongs to another
  // partner fails closed (no auto-approval). Say so and keep the picker usable
  // so the link can be repaired.
  const ringInvalid =
    ringsLoaded && !ringsLoading && selectedRingId !== "" && !selectedRing;
  const ringLegacyRules = legacyAppRules(effectiveLink?.inlineSettings);
  const meta = FEATURE_META.patch;
  const openCreateRing = () => {
    setRingEditorError(undefined);
    setRingEditorMode("create");
    setRingEditorOpen(true);
  };
  const openEditRing = () => {
    if (!selectedRing) return;
    setRingEditorError(undefined);
    setRingEditorMode("edit");
    setRingEditorOpen(true);
  };
  const handleRingEditorSubmit = async (values: UpdateRingFormValues) => {
    const editing = ringEditorMode === "edit" && !!selectedRing;
    setRingSubmitting(true);
    setRingEditorError(undefined);
    try {
      const url = editing
        ? `/update-rings/${selectedRing!.id}`
        : "/update-rings";
      // runaction-exempt: inline ringEditorError UI (banner in the ring editor dialog)
      const response = await fetchWithAuth(url, {
        method: editing ? "PATCH" : "POST",
        body: JSON.stringify({
          name: values.name,
          description: values.description,
          ringOrder: values.ringOrder,
          deferralDays: values.deferralDays,
          deadlineDays: values.deadlineDays,
          gracePeriodHours: values.gracePeriodHours,
          autoApprove: values.autoApprove,
          categoryRules: values.categoryRules,
          appRules: values.appRules,
        }),
      });
      if (!response.ok) {
        // Surface the server's reason (e.g. a duplicate application rule).
        const body: unknown = await response.json().catch(() => null);
        throw new Error(
          extractApiError(
            body,
            editing ? "Failed to update ring" : "Failed to create update ring",
          ),
        );
      }
      let createdId: string | undefined;
      try {
        const payload = await response.json();
        createdId = payload?.data?.id ?? payload?.id;
      } catch {
        // response body is optional for our purposes
      }
      await fetchRings();
      if (!editing && createdId) setSelectedRingId(createdId);
      setRingEditorOpen(false);
    } catch (err) {
      setRingEditorError(
        err instanceof Error ? err.message : "Failed to save ring",
      );
    } finally {
      setRingSubmitting(false);
    }
  };
  return (
    <FeatureTabShell
      title={meta.label}
      description={meta.description}
      icon={<PackageCheck className="h-5 w-5" />}
      isConfigured={!!existingLink || isInherited}
      saving={saving}
      error={validationError ?? error}
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
      {/* Approval Ring */}
      <div>
        <h3 className="text-sm font-semibold">
          {i18n.t(
            "policies:configurationPolicies.featureTabs.patchTab.approvalRing",
          )}
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          {i18n.t(
            "policies:configurationPolicies.featureTabs.patchTab.selectWhichUpdateRingGovernsPatchApprovals",
          )}
        </p>
        {ringsLoading ? (
          <div className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {i18n.t(
              "policies:configurationPolicies.featureTabs.patchTab.loadingRings",
            )}
          </div>
        ) : (
          <div className="mt-2 flex items-center gap-2">
            <select
              data-testid="approval-ring-select"
              aria-label={i18n.t(
                "policies:configurationPolicies.featureTabs.patchTab.approvalRing",
              )}
              value={selectedRingId}
              onChange={(e) => setSelectedRingId(e.target.value)}
              className="h-10 flex-1 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            >
              <option value="">
                {i18n.t(
                  "policies:configurationPolicies.featureTabs.patchTab.noRingManualApprovalsOnly",
                )}
              </option>
              {ringInvalid && (
                <option value={selectedRingId} disabled>
                  {i18n.t(
                    "policies:configurationPolicies.featureTabs.patchTab.unavailableRingOption",
                  )}
                </option>
              )}
              {rings.map((ring) => (
                <option key={ring.id} value={ring.id}>
                  [{ring.ringOrder}] {ring.name}
                  {ring.deferralDays > 0 ? ` (${ring.deferralDays}d hold)` : ""}
                </option>
              ))}
            </select>
            {selectedRing && (
              <button
                type="button"
                onClick={openEditRing}
                data-testid="patch-edit-ring"
                className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-md border px-3 text-sm font-medium transition hover:bg-muted"
              >
                <Pencil className="h-3.5 w-3.5" />
                {i18n.t("common:actions.edit")}
              </button>
            )}
            <button
              type="button"
              onClick={openCreateRing}
              data-testid="patch-new-ring"
              className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-md border px-3 text-sm font-medium transition hover:bg-muted"
            >
              <Plus className="h-3.5 w-3.5" />
              {i18n.t(
                "policies:configurationPolicies.featureTabs.patchTab.newRing",
              )}
            </button>
          </div>
        )}
        {ringsError && (
          <p className="mt-2 text-xs text-destructive">{ringsError}</p>
        )}
        {ringInvalid ? (
          <div
            role="alert"
            data-testid="patch-ring-invalid"
            className="mt-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs"
          >
            <p className="font-medium text-destructive">
              {i18n.t(
                "policies:configurationPolicies.featureTabs.patchTab.ringInvalidTitle",
              )}
            </p>
            <p className="mt-1 text-muted-foreground">
              {i18n.t(
                "policies:configurationPolicies.featureTabs.patchTab.ringInvalidBody",
              )}
            </p>
            {ringLegacyRules.length > 0 && (
              <p className="mt-1 text-muted-foreground">
                {i18n.t(
                  "policies:configurationPolicies.featureTabs.patchTab.ringInvalidLegacyRules",
                  {
                    rules: ringLegacyRules
                      .map((rule) => rule.displayName ?? rule.packageId)
                      .join(", "),
                  },
                )}
              </p>
            )}
          </div>
        ) : (
          <p
            className="mt-2 text-xs text-muted-foreground"
            data-testid="patch-ring-owns-approval-hint"
          >
            {selectedRingId
              ? i18n.t(
                  "policies:configurationPolicies.featureTabs.patchTab.ringOwnsApprovalHint",
                )
              : i18n.t(
                  "policies:configurationPolicies.featureTabs.patchTab.noRingManualApprovalHint",
                )}
          </p>
        )}
        {selectedRing && (
          <div className="mt-2 flex gap-4 text-xs text-muted-foreground">
            <span>
              {i18n.t(
                "policies:configurationPolicies.featureTabs.patchTab.hold",
              )}
              {selectedRing.deferralDays === 0
                ? i18n.t("common:labels.none")
                : `${selectedRing.deferralDays}d`}
            </span>
            <span>
              {i18n.t(
                "policies:configurationPolicies.featureTabs.patchTab.deadline",
              )}
              {selectedRing.deadlineDays == null
                ? i18n.t("common:labels.none")
                : `${selectedRing.deadlineDays}d`}
            </span>
            <span>
              {i18n.t(
                "policies:configurationPolicies.featureTabs.patchTab.rebootGrace",
              )}
              {selectedRing.gracePeriodHours}
              {i18n.t("policies:configurationPolicies.featureTabs.patchTab.h")}
            </span>
          </div>
        )}
      </div>

      {/* Patch Sources — #1428 removed the source checkboxes intending them to
          "live on Update Rings only", but the ring has no sources control and its
          sources column never reaches the approval evaluator; the value that IS
          evaluated is this policy's settings.sources, which was left stranded at
          the default ['os']. That made third-party (winget/Homebrew) patches
          impossible to enable through the UI — the evaluator source-filters them
          out at patchApprovalEvaluator before app rules or ring auto-approve run.
          Restore the switch so techs can actually opt in. OS stays always-on to
          honour the schema's min(1) sources constraint. */}
      <div className="mt-6">
        <h3 className="text-sm font-semibold">
          {i18n.t(
            "policies:configurationPolicies.featureTabs.patchTab.patchSources",
          )}
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          {i18n.t(
            "policies:configurationPolicies.featureTabs.patchTab.patchSourcesDescription",
          )}
        </p>
        <div className="mt-2 flex items-center justify-between rounded-md border bg-background px-4 py-3">
          <div className="pr-4">
            <p className="text-sm font-medium">
              {i18n.t(
                "policies:configurationPolicies.featureTabs.patchTab.includeThirdPartySoftwareUpdates",
              )}
            </p>
            <p className="text-xs text-muted-foreground">
              {i18n.t(
                "policies:configurationPolicies.featureTabs.patchTab.thirdPartySoftwareUpdatesDescription",
              )}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={settings.sources.includes('third_party')}
            data-testid="patch-third-party-sources-toggle"
            onClick={() =>
              update('sources', settings.sources.includes('third_party') ? ['os'] : ['os', 'third_party'])
            }
            className={cn(
              'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition',
              settings.sources.includes('third_party') ? 'bg-emerald-500/80' : 'bg-muted'
            )}
          >
            <span
              className={cn(
                'inline-block h-5 w-5 rounded-full bg-white transition',
                settings.sources.includes('third_party') ? 'translate-x-5' : 'translate-x-1'
              )}
            />
          </button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground" data-testid="patch-third-party-ring-hint">
          {i18n.t("policies:configurationPolicies.featureTabs.patchTab.thirdPartyRingHint")}
        </p>
      </div>

      {/* Schedule */}
      <div className="mt-6">
        <h3 className="text-sm font-semibold">
          {i18n.t(
            "policies:configurationPolicies.featureTabs.patchTab.installationSchedule",
          )}
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          {i18n.t(
            "policies:configurationPolicies.featureTabs.patchTab.whenApprovedPatchesAreInstalledOnDevices",
          )}
        </p>
        <div className="mt-2 grid gap-4 sm:grid-cols-3">
          <div>
            <label
              htmlFor="patch-schedule-frequency"
              className="text-xs text-muted-foreground"
            >
              {i18n.t(
                "policies:configurationPolicies.featureTabs.patchTab.frequency",
              )}
            </label>
            <select
              id="patch-schedule-frequency"
              data-testid="patch-schedule-frequency"
              value={settings.scheduleFrequency}
              onChange={(e) =>
                update("scheduleFrequency", e.target.value as ScheduleFrequency)
              }
              className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
            >
              {scheduleOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label
              htmlFor="patch-schedule-time"
              className="text-xs text-muted-foreground"
            >
              {i18n.t(
                "policies:configurationPolicies.featureTabs.patchTab.time",
              )}
            </label>
            <input
              id="patch-schedule-time"
              data-testid="patch-schedule-time"
              type="time"
              value={settings.scheduleTime}
              onChange={(e) => update("scheduleTime", e.target.value)}
              className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
            />
          </div>
          {settings.scheduleFrequency === "weekly" && (
            <div>
              <label
                htmlFor="patch-schedule-day-of-week"
                className="text-xs text-muted-foreground"
              >
                {i18n.t(
                  "policies:configurationPolicies.featureTabs.patchTab.dayOfWeek",
                )}
              </label>
              <select
                id="patch-schedule-day-of-week"
                data-testid="patch-schedule-day-of-week"
                value={settings.scheduleDayOfWeek}
                onChange={(e) => update("scheduleDayOfWeek", e.target.value)}
                className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
              >
                {dayOfWeekOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          )}
          {settings.scheduleFrequency === "monthly" && (
            <div>
              <label
                htmlFor="patch-schedule-day-of-month"
                className="text-xs text-muted-foreground"
              >
                {i18n.t(
                  "policies:configurationPolicies.featureTabs.patchTab.dayOfMonth",
                )}
              </label>
              <input
                id="patch-schedule-day-of-month"
                data-testid="patch-schedule-day-of-month"
                type="number"
                min={1}
                max={28}
                value={settings.scheduleDayOfMonth}
                onChange={(e) =>
                  update("scheduleDayOfMonth", Number(e.target.value) || 1)
                }
                className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
              />
            </div>
          )}
        </div>

        {/* #5128 W3 — offline behaviour for this schedule. Sits with the
            schedule fields because it is a scheduling decision: it says what
            happens to a device that is not there when the occurrence fires. */}
        <div className="mt-4">
          <span className="text-xs text-muted-foreground">
            {i18n.t(
              "policies:configurationPolicies.featureTabs.patchTab.offlineDevices",
            )}
          </span>
          <div
            role="radiogroup"
            aria-label={i18n.t(
              "policies:configurationPolicies.featureTabs.patchTab.offlineDevices",
            )}
            data-testid="patch-offline-behavior"
            className="mt-2 grid gap-3 sm:grid-cols-2"
          >
            {offlineBehaviorOptions.map((option) => (
              <label
                key={option.value}
                className={cn(
                  "flex cursor-pointer flex-col gap-1 rounded-md border p-3 text-sm transition",
                  settings.offlineBehavior === option.value
                    ? "border-primary/40 bg-primary/10 text-primary"
                    : "border-muted text-muted-foreground hover:text-foreground",
                )}
              >
                <input
                  type="radio"
                  name="offlineBehavior"
                  value={option.value}
                  data-testid={`patch-offline-behavior-${option.value}`}
                  checked={settings.offlineBehavior === option.value}
                  onChange={() => update("offlineBehavior", option.value)}
                  className="hidden"
                />
                <span className="font-medium text-foreground">
                  {option.label}
                </span>
                <span className="text-xs text-muted-foreground">
                  {option.description}
                </span>
              </label>
            ))}
          </div>
        </div>
      </div>

      {/* Reboot Policy */}
      <div className="mt-6">
        <h3 className="text-sm font-semibold">
          {i18n.t(
            "policies:configurationPolicies.featureTabs.patchTab.rebootPolicy",
          )}
        </h3>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          {rebootOptions.map((option) => (
            <label
              key={option.value}
              className={cn(
                "flex cursor-pointer flex-col gap-1 rounded-md border p-3 text-sm transition",
                settings.rebootPolicy === option.value
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-muted text-muted-foreground hover:text-foreground",
              )}
            >
              <input
                type="radio"
                name="rebootPolicy"
                value={option.value}
                checked={settings.rebootPolicy === option.value}
                onChange={() => update("rebootPolicy", option.value)}
                className="hidden"
              />
              <span className="font-medium text-foreground">
                {option.label}
              </span>
              <span className="text-xs text-muted-foreground">
                {option.description}
              </span>
            </label>
          ))}
        </div>
        {settings.rebootPolicy !== "never" && (
          <div className="mt-4 max-w-xs">
            <label
              htmlFor="patch-reboot-delay-minutes"
              className="text-xs text-muted-foreground"
            >
              {i18n.t(
                "policies:configurationPolicies.featureTabs.patchTab.rebootDelayMinutes",
              )}
            </label>
            <input
              id="patch-reboot-delay-minutes"
              data-testid="patch-reboot-delay-minutes"
              type="number"
              min={1}
              max={1440}
              value={settings.rebootDelayMinutes}
              onChange={(e) =>
                update("rebootDelayMinutes", Number(e.target.value) || 15)
              }
              className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              {i18n.t(
                "policies:configurationPolicies.featureTabs.patchTab.rebootDelayMinutesDescription",
              )}
            </p>
          </div>
        )}
        {/* End-user reboot deferral (#3207). Deliberately no "don't warn"
            switch: #3197 made at least one warning an invariant. */}
        {settings.rebootPolicy !== "never" && (
          <div className="mt-4">
            <div className="flex items-center justify-between rounded-md border bg-background px-4 py-3">
              <div className="pr-4">
                <p className="text-sm font-medium">
                  {i18n.t(
                    "policies:configurationPolicies.featureTabs.patchTab.rebootAllowDeferral",
                  )}
                </p>
                <p className="text-xs text-muted-foreground">
                  {i18n.t(
                    "policies:configurationPolicies.featureTabs.patchTab.rebootAllowDeferralDescription",
                  )}
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={settings.rebootAllowDeferral}
                data-testid="patch-reboot-allow-deferral-toggle"
                onClick={() =>
                  update("rebootAllowDeferral", !settings.rebootAllowDeferral)
                }
                className={cn(
                  "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition",
                  settings.rebootAllowDeferral
                    ? "bg-emerald-500/80"
                    : "bg-muted",
                )}
              >
                <span
                  className={cn(
                    "inline-block h-5 w-5 rounded-full bg-white transition",
                    settings.rebootAllowDeferral
                      ? "translate-x-5"
                      : "translate-x-1",
                  )}
                />
              </button>
            </div>
            {settings.rebootAllowDeferral && (
              <div className="mt-3 grid gap-4 sm:grid-cols-2">
                <div>
                  <label
                    htmlFor="patch-reboot-max-deferrals"
                    className="text-xs text-muted-foreground"
                  >
                    {i18n.t(
                      "policies:configurationPolicies.featureTabs.patchTab.rebootMaxDeferrals",
                    )}
                  </label>
                  <input
                    id="patch-reboot-max-deferrals"
                    data-testid="patch-reboot-max-deferrals"
                    type="number"
                    min={1}
                    max={10}
                    value={settings.rebootMaxDeferrals}
                    onChange={(e) =>
                      update(
                        "rebootMaxDeferrals",
                        Number(e.target.value) || 3,
                      )
                    }
                    className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    {i18n.t(
                      "policies:configurationPolicies.featureTabs.patchTab.rebootMaxDeferralsDescription",
                    )}
                  </p>
                </div>
                <div>
                  <label
                    htmlFor="patch-reboot-deferral-minutes"
                    className="text-xs text-muted-foreground"
                  >
                    {i18n.t(
                      "policies:configurationPolicies.featureTabs.patchTab.rebootDeferralMinutes",
                    )}
                  </label>
                  <input
                    id="patch-reboot-deferral-minutes"
                    data-testid="patch-reboot-deferral-minutes"
                    type="number"
                    min={5}
                    max={1440}
                    value={settings.rebootDeferralMinutes}
                    onChange={(e) =>
                      update(
                        "rebootDeferralMinutes",
                        Number(e.target.value) || 60,
                      )
                    }
                    className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    {i18n.t(
                      "policies:configurationPolicies.featureTabs.patchTab.rebootDeferralMinutesDescription",
                    )}
                  </p>
                </div>
              </div>
            )}
          </div>
        )}
        {/* Custom restart-prompt text (#8030). Blank keeps the built-in copy. */}
        {settings.rebootPolicy !== "never" && (
          <div className="mt-4 rounded-md border bg-background px-4 py-3">
            <p className="text-sm font-medium">
              {i18n.t(
                "policies:configurationPolicies.featureTabs.patchTab.rebootPromptText",
              )}
            </p>
            <p className="text-xs text-muted-foreground">
              {i18n.t(
                "policies:configurationPolicies.featureTabs.patchTab.rebootPromptTextDescription",
              )}
            </p>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <div>
                <label
                  htmlFor="patch-reboot-prompt-title"
                  className="text-xs text-muted-foreground"
                >
                  {i18n.t(
                    "policies:configurationPolicies.featureTabs.patchTab.rebootPromptTitle",
                  )}
                </label>
                <input
                  id="patch-reboot-prompt-title"
                  data-testid="patch-reboot-prompt-title"
                  type="text"
                  maxLength={REBOOT_PROMPT_TITLE_MAX}
                  value={settings.rebootPromptTitle ?? ""}
                  onChange={(e) =>
                    update("rebootPromptTitle", promptTextOrNull(e.target.value))
                  }
                  className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
                />
              </div>
              <div>
                <label
                  htmlFor="patch-reboot-prompt-button"
                  className="text-xs text-muted-foreground"
                >
                  {i18n.t(
                    "policies:configurationPolicies.featureTabs.patchTab.rebootPromptButton",
                  )}
                </label>
                <input
                  id="patch-reboot-prompt-button"
                  data-testid="patch-reboot-prompt-button"
                  type="text"
                  maxLength={REBOOT_PROMPT_BUTTON_MAX}
                  value={settings.rebootPromptButton ?? ""}
                  onChange={(e) =>
                    update("rebootPromptButton", promptTextOrNull(e.target.value))
                  }
                  className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
                />
              </div>
            </div>
            <div className="mt-3">
              <label
                htmlFor="patch-reboot-prompt-body"
                className="text-xs text-muted-foreground"
              >
                {i18n.t(
                  "policies:configurationPolicies.featureTabs.patchTab.rebootPromptBody",
                )}
              </label>
              <textarea
                id="patch-reboot-prompt-body"
                data-testid="patch-reboot-prompt-body"
                rows={3}
                maxLength={REBOOT_PROMPT_BODY_MAX}
                value={settings.rebootPromptBody ?? ""}
                onChange={(e) =>
                  update("rebootPromptBody", promptTextOrNull(e.target.value))
                }
                className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {i18n.t(
                  "policies:configurationPolicies.featureTabs.patchTab.rebootPromptBodyDescription",
                  { placeholder: REBOOT_PROMPT_COUNTDOWN_PLACEHOLDER },
                )}
              </p>
            </div>
            {promptError && (
              <p
                data-testid="patch-reboot-prompt-error"
                role="alert"
                className="mt-2 text-xs text-destructive"
              >
                {promptError}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Windows Update source enforcement (#1872) */}
      <div className="mt-6">
        <h3 className="text-sm font-semibold">
          {i18n.t(
            "policies:configurationPolicies.featureTabs.patchTab.windowsUpdateSource",
          )}
        </h3>
        <div className="mt-2 flex items-center justify-between rounded-md border bg-background px-4 py-3">
          <div className="pr-4">
            <p className="text-sm font-medium">
              {i18n.t(
                "policies:configurationPolicies.featureTabs.patchTab.manageWindowsUpdateExclusivelyThroughBreeze",
              )}
            </p>
            <p className="text-xs text-muted-foreground">
              {i18n.t(
                "policies:configurationPolicies.featureTabs.patchTab.suppressesTheEndpointSNativeWindowsUpdate",
              )}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={settings.exclusiveWindowsUpdate}
            data-testid="patch-exclusive-windows-update-toggle"
            onClick={() =>
              update("exclusiveWindowsUpdate", !settings.exclusiveWindowsUpdate)
            }
            className={cn(
              "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition",
              settings.exclusiveWindowsUpdate
                ? "bg-emerald-500/80"
                : "bg-muted",
            )}
          >
            <span
              className={cn(
                "inline-block h-5 w-5 rounded-full bg-white transition",
                settings.exclusiveWindowsUpdate
                  ? "translate-x-5"
                  : "translate-x-1",
              )}
            />
          </button>
        </div>
      </div>

      {/* Inline ring editor */}
      <Dialog
        open={ringEditorOpen}
        onClose={() => setRingEditorOpen(false)}
        title={
          ringEditorMode === "edit"
            ? i18n.t(
                "policies:configurationPolicies.featureTabs.patchTab.editUpdateRing",
              )
            : i18n.t(
                "policies:configurationPolicies.featureTabs.patchTab.createUpdateRing",
              )
        }
        maxWidth="2xl"
        alignTop
        className="flex max-h-[90vh] flex-col"
      >
        <div className="flex items-center justify-between border-b px-6 py-4">
          <h2 className="text-lg font-semibold">
            {ringEditorMode === "edit"
              ? i18n.t(
                  "policies:configurationPolicies.featureTabs.patchTab.editUpdateRing",
                )
              : i18n.t(
                  "policies:configurationPolicies.featureTabs.patchTab.createUpdateRing",
                )}
          </h2>
          <button
            type="button"
            aria-label={i18n.t("common:actions.close")}
            onClick={() => setRingEditorOpen(false)}
            className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {i18n.t(
              "policies:configurationPolicies.featureTabs.patchTab.times",
            )}
          </button>
        </div>
        <div className="overflow-y-auto px-6 py-5">
          {ringEditorError && (
            <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {ringEditorError}
            </div>
          )}
          <UpdateRingForm
            key={
              ringEditorMode === "edit" ? (selectedRing?.id ?? "edit") : "new"
            }
            onSubmit={handleRingEditorSubmit}
            onCancel={() => setRingEditorOpen(false)}
            loading={ringSubmitting}
            submitLabel={
              ringEditorMode === "edit"
                ? i18n.t(
                    "policies:configurationPolicies.featureTabs.patchTab.saveChanges",
                  )
                : i18n.t(
                    "policies:configurationPolicies.featureTabs.patchTab.createRing",
                  )
            }
            usage={
              ringEditorMode === "edit" && selectedRing
                ? { deviceCount: selectedRing.deviceCount }
                : undefined
            }
            defaultValues={
              ringEditorMode === "edit" && selectedRing
                ? {
                    name: selectedRing.name,
                    description: selectedRing.description ?? undefined,
                    ringOrder: selectedRing.ringOrder,
                    deferralDays: selectedRing.deferralDays,
                    deadlineDays: selectedRing.deadlineDays,
                    gracePeriodHours: selectedRing.gracePeriodHours,
                    autoApprove: selectedRing.autoApprove ?? {
                      enabled: false,
                      severities: [],
                      deferralDays: 0,
                    },
                    categoryRules: selectedRing.categoryRules,
                    appRules: selectedRing.appRules ?? [],
                  }
                : undefined
            }
          />
        </div>
      </Dialog>
    </FeatureTabShell>
  );
}
