import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarClock, Loader2, Plus, Save, Trash2 } from "lucide-react";
import { fetchWithAuth } from "../../stores/auth";
import { useDefaultOwnerScope } from "@/hooks/useDefaultOwnerScope";
import { errorKindOf, throwIfNotOk, type LoadErrorKind } from "@/lib/httpError";
import { friendlyFetchError } from "@/lib/utils";
import AccessDenied from "../shared/AccessDenied";
type ToggleRowProps = {
  label: string;
  description: string;
  checked: boolean;
  onChange: (next: boolean) => void;
};
function ToggleRow({ label, description, checked, onChange }: ToggleRowProps) {
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
type SecurityPolicy = {
  id: string;
  name: string;
  description?: string;
  providerId?: string;
  scanSchedule: "daily" | "weekly" | "monthly" | "manual";
  realTimeProtection: boolean;
  autoQuarantine: boolean;
  severityThreshold: "low" | "medium" | "high" | "critical";
  exclusions: string[];
  createdAt: string;
  updatedAt: string;
};
type SecurityPolicyEditorProps = {
  policyId?: string;
  onSave?: (policy: SecurityPolicy) => void;
};
const minuteOptions = ["0", "15", "30", "45"];
const hourOptions = ["0", "2", "6", "12", "18"];
const dayOfMonthOptions = ["*", "1", "15"];
const dayOfWeekOptions = [
  { labelKey: null, value: "*" },
  { labelKey: "securitySecurityPolicyEditor.mon", value: "1" },
  { labelKey: "securitySecurityPolicyEditor.tue", value: "2" },
  { labelKey: "securitySecurityPolicyEditor.wed", value: "3" },
  { labelKey: "securitySecurityPolicyEditor.thu", value: "4" },
  { labelKey: "securitySecurityPolicyEditor.fri", value: "5" },
  { labelKey: "securitySecurityPolicyEditor.sat", value: "6" },
  { labelKey: "securitySecurityPolicyEditor.sun", value: "0" },
];
const scanScheduleFromCron = (
  _minute: string,
  hour: string,
  dayOfMonth: string,
  dayOfWeek: string,
): "daily" | "weekly" | "monthly" | "manual" => {
  if (dayOfMonth !== "*") return "monthly";
  if (dayOfWeek !== "*") return "weekly";
  if (hour !== "*") return "daily";
  return "manual";
};
export default function SecurityPolicyEditor({
  policyId,
  onSave,
}: SecurityPolicyEditorProps) {
  const { t } = useTranslation("security");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [errorKind, setErrorKind] = useState<LoadErrorKind>("none");
  const [policyName, setPolicyName] = useState("");
  const [description, setDescription] = useState("");
  const [realTimeEnabled, setRealTimeEnabled] = useState(true);
  const [behavioralEnabled, setBehavioralEnabled] = useState(true);
  const [cloudLookupEnabled, setCloudLookupEnabled] = useState(true);
  const [scheduledEnabled, setScheduledEnabled] = useState(true);
  const [scanMinute, setScanMinute] = useState("0");
  const [scanHour, setScanHour] = useState("2");
  const [scanDayOfMonth, setScanDayOfMonth] = useState("*");
  const [scanDayOfWeek, setScanDayOfWeek] = useState("*");
  const [autoQuarantine, setAutoQuarantine] = useState(true);
  const [notifyUser, setNotifyUser] = useState(true);
  const [blockUsb, setBlockUsb] = useState(false);
  const [exclusions, setExclusions] = useState<string[]>([]);
  const [newExclusion, setNewExclusion] = useState("");
  // Ownership axis (#2127, mirrors software/config policies): partner-scope
  // creators may own the baseline partner-wide. Create-only — ownership is
  // immutable after create.
  const { isPartnerScope, defaultOwnerScope } = useDefaultOwnerScope();
  const [ownerScope, setOwnerScope] = useState<"organization" | "partner">(defaultOwnerScope);
  const fetchPolicy = useCallback(async () => {
    // Reset BEFORE the no-policyId bail: otherwise a policyId -> undefined
    // transition (edit -> create) would strand a stale AccessDenied over the
    // create form.
    setError(undefined);
    setErrorKind("none");
    if (!policyId) return;
    setLoading(true);
    try {
      const response = await fetchWithAuth("/security/policies");
      // HttpError (not a bare Error) so a 403 survives the throw and the render
      // can tell "you may not see this" from "this broke, try again" (#2472).
      throwIfNotOk(response);
      const json = await response.json();
      const policies: SecurityPolicy[] = json.data || [];
      const policy = policies.find((p) => p.id === policyId);
      if (policy) {
        setPolicyName(policy.name);
        setDescription(policy.description || "");
        setRealTimeEnabled(policy.realTimeProtection);
        setAutoQuarantine(policy.autoQuarantine);
        setExclusions(policy.exclusions || []);
        setScheduledEnabled(policy.scanSchedule !== "manual");
      }
    } catch (err) {
      console.error("[SecurityPolicyEditor] fetch error:", err);
      const kind = errorKindOf(err);
      setErrorKind(kind);
      // 'denied' renders AccessDenied, which supplies its own copy. Previously the
      // raw `err.message` was rendered, so a denied user was shown the literal
      // string "403 Forbidden". (#2472)
      if (kind === "other") setError(friendlyFetchError(err));
    } finally {
      setLoading(false);
    }
  }, [policyId]);
  useEffect(() => {
    fetchPolicy();
  }, [fetchPolicy]);
  const handleSavePolicy = async () => {
    setSaving(true);
    setError(undefined);
    const scanSchedule = scheduledEnabled
      ? scanScheduleFromCron(
          scanMinute,
          scanHour,
          scanDayOfMonth,
          scanDayOfWeek,
        )
      : "manual";
    const payload = {
      name: policyName,
      // Create-only intent; the server derives the partner from the token.
      ...(policyId
        ? {}
        : { ownerScope: isPartnerScope ? ownerScope : undefined }),
      description,
      scanSchedule,
      realTimeProtection: realTimeEnabled,
      autoQuarantine,
      severityThreshold: "medium" as const,
      exclusions,
    };
    try {
      const url = policyId
        ? `/security/policies/${policyId}`
        : "/security/policies";
      const method = policyId ? "PUT" : "POST";
      const response = await fetchWithAuth(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      // Preserves the status; also stops the raw "403 Forbidden" string from being
      // rendered to the user as if it were a save error message. (#2472)
      throwIfNotOk(response);
      const json = await response.json();
      onSave?.(json.data || json);
    } catch (err) {
      console.error("[SecurityPolicyEditor] save error:", err);
      // A save denial is not a page-level denial (the user could still read the
      // policy), so this stays an inline message rather than an AccessDenied panel.
      setError(friendlyFetchError(err));
    } finally {
      setSaving(false);
    }
  };
  const cronExpression = useMemo(
    () => `${scanMinute} ${scanHour} ${scanDayOfMonth} * ${scanDayOfWeek}`,
    [scanMinute, scanHour, scanDayOfMonth, scanDayOfWeek],
  );
  const handleAddExclusion = () => {
    const trimmed = newExclusion.trim();
    if (!trimmed || exclusions.includes(trimmed)) return;
    setExclusions((prev) => [...prev, trimmed]);
    setNewExclusion("");
  };
  const handleRemoveExclusion = (value: string) => {
    setExclusions((prev) => prev.filter((item) => item !== value));
  };
  const editorHeader = (
    <div className="flex flex-col gap-2">
      <h2 className="text-lg font-semibold">
        {t("securitySecurityPolicyEditor.securityPolicyEditor")}
      </h2>
      <p className="text-sm text-muted-foreground">
        {t(
          "securitySecurityPolicyEditor.tuneProtectionSettingsForDeviceGroups",
        )}
      </p>
    </div>
  );
  // A 403 on the policy read is terminal. Stop before the form: falling through
  // would render the editor pre-filled with empty/default toggle values, which a
  // user could then "save" over a policy they were never allowed to see. (#2472)
  if (errorKind === "denied") {
    return (
      <div className="space-y-6">
        {editorHeader}
        <AccessDenied testId="security-policy-editor-denied" />
      </div>
    );
  }
  return (
    <div className="space-y-6">
      {editorHeader}

      <div className="rounded-lg border bg-card p-6 shadow-xs">
        {!policyId && isPartnerScope && (
          <fieldset
            className="mb-4 space-y-2 rounded-md border p-4"
            data-testid="security-policy-owner"
          >
            <legend className="px-1 text-xs font-medium uppercase text-muted-foreground">
              {t("securitySecurityPolicyEditor.scope")}
            </legend>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="securityPolicyOwnerScope"
                value="partner"
                checked={ownerScope === "partner"}
                onChange={() => setOwnerScope("partner")}
                data-testid="security-policy-owner-partner"
              />
              {t("securitySecurityPolicyEditor.allOrganizations")}
              <span className="text-muted-foreground">
                {t("securitySecurityPolicyEditor.partnerWideTemplate")}
              </span>
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="securityPolicyOwnerScope"
                value="organization"
                checked={ownerScope === "organization"}
                onChange={() => setOwnerScope("organization")}
                data-testid="security-policy-owner-org"
              />
              {t("securitySecurityPolicyEditor.thisOrganizationOnly")}
            </label>
          </fieldset>
        )}
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className="text-xs uppercase text-muted-foreground">
              {t("securitySecurityPolicyEditor.policyName")}
            </label>
            <input
              type="text"
              value={policyName}
              onChange={(event) => setPolicyName(event.target.value)}
              className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            />
          </div>
          <div>
            <label className="text-xs uppercase text-muted-foreground">
              {t("securitySecurityPolicyEditor.description")}
            </label>
            <input
              type="text"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            />
          </div>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-6">
          <div className="rounded-lg border bg-card p-6 shadow-xs">
            <h3 className="text-base font-semibold">
              {t("securitySecurityPolicyEditor.realTimeProtection")}
            </h3>
            <div className="mt-4 space-y-3">
              <ToggleRow
                label={t("securitySecurityPolicyEditor.realTimeFileMonitoring")}
                description={t(
                  "securitySecurityPolicyEditor.scanNewAndModifiedFilesContinuously",
                )}
                checked={realTimeEnabled}
                onChange={setRealTimeEnabled}
              />
              <ToggleRow
                label={t("securitySecurityPolicyEditor.behavioralMonitoring")}
                description={t(
                  "securitySecurityPolicyEditor.detectSuspiciousProcessBehaviorAndScripts",
                )}
                checked={behavioralEnabled}
                onChange={setBehavioralEnabled}
              />
              <ToggleRow
                label={t("securitySecurityPolicyEditor.cloudThreatLookup")}
                description={t(
                  "securitySecurityPolicyEditor.useCloudReputationForNewIndicators",
                )}
                checked={cloudLookupEnabled}
                onChange={setCloudLookupEnabled}
              />
            </div>
          </div>

          <div className="rounded-lg border bg-card p-6 shadow-xs">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold">
                {t("securitySecurityPolicyEditor.scheduledScans")}
              </h3>
              <button
                type="button"
                onClick={() => setScheduledEnabled(!scheduledEnabled)}
                className={`rounded-full border px-3 py-1 text-xs font-semibold ${scheduledEnabled ? "bg-emerald-500/15 text-emerald-700" : "bg-muted text-muted-foreground"}`}
              >
                {scheduledEnabled
                  ? t("securitySecurityPolicyEditor.enabled")
                  : t("securitySecurityPolicyEditor.disabled")}
              </button>
            </div>
            <div
              className={`mt-4 space-y-3 ${scheduledEnabled ? "" : "opacity-50"}`}
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="text-xs uppercase text-muted-foreground">
                    {t("securitySecurityPolicyEditor.minute")}
                  </label>
                  <select
                    disabled={!scheduledEnabled}
                    value={scanMinute}
                    onChange={(event) => setScanMinute(event.target.value)}
                    className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  >
                    {minuteOptions.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-xs uppercase text-muted-foreground">
                    {t("securitySecurityPolicyEditor.hour")}
                  </label>
                  <select
                    disabled={!scheduledEnabled}
                    value={scanHour}
                    onChange={(event) => setScanHour(event.target.value)}
                    className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  >
                    {hourOptions.map((option) => (
                      <option key={option} value={option}>
                        {option.padStart(2, "0")}:00
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-xs uppercase text-muted-foreground">
                    {t("securitySecurityPolicyEditor.dayOfMonth")}
                  </label>
                  <select
                    disabled={!scheduledEnabled}
                    value={scanDayOfMonth}
                    onChange={(event) => setScanDayOfMonth(event.target.value)}
                    className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  >
                    {dayOfMonthOptions.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-xs uppercase text-muted-foreground">
                    {t("securitySecurityPolicyEditor.dayOfWeek")}
                  </label>
                  <select
                    disabled={!scheduledEnabled}
                    value={scanDayOfWeek}
                    onChange={(event) => setScanDayOfWeek(event.target.value)}
                    className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  >
                    {dayOfWeekOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.labelKey ? t(/* i18n-dynamic */ option.labelKey) : option.value}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="flex items-center gap-2 rounded-md border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                <CalendarClock className="h-4 w-4" />
                {t("securitySecurityPolicyEditor.cron")}
                <span className="font-mono text-foreground">
                  {cronExpression}
                </span>
              </div>
            </div>
          </div>
        </div>

        <div className="space-y-6">
          <div className="rounded-lg border bg-card p-6 shadow-xs">
            <h3 className="text-base font-semibold">
              {t("securitySecurityPolicyEditor.exclusions")}
            </h3>
            <p className="text-sm text-muted-foreground">
              {t(
                "securitySecurityPolicyEditor.skipTrustedLocationsDuringScans",
              )}
            </p>
            <div className="mt-4 flex gap-2">
              <input
                type="text"
                value={newExclusion}
                onChange={(event) => setNewExclusion(event.target.value)}
                placeholder={t("securitySecurityPolicyEditor.addPathOrProcess")}
                className="h-10 flex-1 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              />
              <button
                type="button"
                onClick={handleAddExclusion}
                className="inline-flex items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm font-medium hover:bg-muted"
              >
                <Plus className="h-4 w-4" />
                {t("securitySecurityPolicyEditor.add")}
              </button>
            </div>
            <div className="mt-4 space-y-2">
              {exclusions.map((item) => (
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

          <div className="rounded-lg border bg-card p-6 shadow-xs">
            <h3 className="text-base font-semibold">
              {t("securitySecurityPolicyEditor.actions")}
            </h3>
            <div className="mt-4 space-y-3">
              <ToggleRow
                label={t("securitySecurityPolicyEditor.autoQuarantine")}
                description={t(
                  "securitySecurityPolicyEditor.moveThreatsToQuarantineImmediately",
                )}
                checked={autoQuarantine}
                onChange={setAutoQuarantine}
              />
              <ToggleRow
                label={t("securitySecurityPolicyEditor.notifyUserOnDetection")}
                description={t(
                  "securitySecurityPolicyEditor.sendDeviceNotificationsWhenThreatsAreFound",
                )}
                checked={notifyUser}
                onChange={setNotifyUser}
              />
              <ToggleRow
                label={t(
                  "securitySecurityPolicyEditor.blockUntrustedUSBDevices",
                )}
                description={t(
                  "securitySecurityPolicyEditor.preventUnknownRemovableMedia",
                )}
                checked={blockUsb}
                onChange={setBlockUsb}
              />
            </div>
          </div>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-center">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      <div className="flex justify-end">
        <button
          type="button"
          onClick={handleSavePolicy}
          disabled={saving || loading}
          className="inline-flex items-center gap-2 rounded-md border bg-background px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
        >
          {saving ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Save className="h-4 w-4" />
          )}
          {saving
            ? t("securitySecurityPolicyEditor.saving")
            : t("securitySecurityPolicyEditor.savePolicy")}
        </button>
      </div>
    </div>
  );
}
