import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useId,
  type ReactNode,
} from "react";
import {
  Activity,
  Plus,
  Trash2,
  Server,
  Cpu,
  Bell,
  ChevronDown,
  ChevronRight,
  Settings2,
} from "lucide-react";
import type { FeatureTabProps, FeatureType } from "./types";
import { FEATURE_META } from "./types";
import { useFeatureLink } from "./useFeatureLink";
import { handleToggleKeyDown } from "./disclosureKeyboard";
import FeatureTabShell from "./FeatureTabShell";
import { fetchWithAuth } from "../../../stores/auth";
import { useTranslation } from "react-i18next";
import { i18n } from "@/lib/i18n";
// ============================================
// Types
// ============================================
type WatchType = "service" | "process";
type AlertSeverity = "critical" | "high" | "medium" | "low" | "info";
type WatchEntry = {
  watchType: WatchType;
  name: string;
  displayName?: string;
  enabled: boolean;
  alertOnStop: boolean;
  alertAfterConsecutiveFailures: number;
  alertSeverity: AlertSeverity;
  cpuThresholdPercent?: number;
  memoryThresholdMb?: number;
  thresholdDurationSeconds: number;
  autoRestart: boolean;
  maxRestartAttempts: number;
  restartCooldownSeconds: number;
};
// Server-evaluated alert rules (metric thresholds, offline detection, event log
// alerts) used to live here as `alertRules`/`eventLogAlerts`. They are now owned
// exclusively by the `alert_rule` feature link (2026-07-30 consolidation) and the
// API rejects a monitoring payload that carries either key, so this tab neither
// reads nor writes them — see AlertRuleTab.tsx.
type MonitoringSettings = {
  checkIntervalSeconds: number;
  watches: WatchEntry[];
};
type KnownService = {
  name: string;
  source: string;
  watchType: string | null;
};
// ============================================
// Constants
// ============================================
const defaults: MonitoringSettings = {
  checkIntervalSeconds: 60,
  watches: [],
};
const defaultWatch: WatchEntry = {
  watchType: "service",
  name: "",
  enabled: true,
  alertOnStop: true,
  alertAfterConsecutiveFailures: 2,
  alertSeverity: "high",
  thresholdDurationSeconds: 300,
  autoRestart: false,
  maxRestartAttempts: 3,
  restartCooldownSeconds: 300,
};
// The feature tab strip in ConfigPolicyDetailPage is hash-driven (useHashTab
// over VALID_TABS, whose feature ids are the raw FeatureType keys), so the
// pointer below switches tabs by writing the hash — the same thing the strip's
// own buttons do. Typed as FeatureType so a renamed feature key fails to
// compile instead of silently producing a dead link.
const ALERTS_TAB: FeatureType = "alert_rule";
function goToAlertsTab() {
  if (typeof window === "undefined") return;
  window.location.hash = ALERTS_TAB;
}
const createSeverityOptions = (): {
  value: AlertSeverity;
  label: string;
  color: string;
}[] => [
  {
    value: "critical",
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.monitoringTab.critical",
    ),
    color: "bg-red-500",
  },
  {
    value: "high",
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.monitoringTab.high",
    ),
    color: "bg-orange-500",
  },
  {
    value: "medium",
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.monitoringTab.medium",
    ),
    color: "bg-yellow-500",
  },
  {
    value: "low",
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.monitoringTab.low",
    ),
    color: "bg-blue-500",
  },
  {
    value: "info",
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.monitoringTab.info",
    ),
    color: "bg-gray-500",
  },
];
// Reads persisted inline settings into tab state. Deliberately picks only the
// keys this tab still owns rather than spreading `stored` — a saved link from
// before the alert consolidation still carries `alertRules`/`eventLogAlerts`,
// and spreading them back into state would put them straight into the next save
// payload, which the API now rejects.
// Counts the legacy alert rules a stored mirror still carries. readSettings
// drops those keys from tab state (they can no longer be saved), and dropping
// them silently would look like the tab had eaten the tech's rules — so the
// count drives a non-blocking info banner pointing at where they went.
function legacyAlertRuleCount(
  stored: Record<string, unknown> | null | undefined,
): number {
  const raw = (stored ?? {}) as Record<string, unknown>;
  const count = (value: unknown) => (Array.isArray(value) ? value.length : 0);
  return count(raw.alertRules) + count(raw.eventLogAlerts);
}
function readSettings(
  stored: Record<string, unknown> | null | undefined,
  fallback: MonitoringSettings,
): MonitoringSettings {
  const raw = (stored ?? {}) as Partial<MonitoringSettings>;
  return {
    checkIntervalSeconds:
      typeof raw.checkIntervalSeconds === "number"
        ? raw.checkIntervalSeconds
        : fallback.checkIntervalSeconds,
    watches: Array.isArray(raw.watches)
      ? raw.watches.map((w) => ({ ...defaultWatch, ...w }))
      : fallback.watches,
  };
}
// ============================================
// Shared UI Components
// ============================================
function SeverityPill({ severity }: { severity: AlertSeverity }) {
  useTranslation("policies");
  const severityOptions = createSeverityOptions();
  const opt = severityOptions.find((o) => o.value === severity);
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium">
      <span className={`h-2 w-2 rounded-full ${opt?.color ?? "bg-gray-400"}`} />
      {opt?.label ?? severity}
    </span>
  );
}
function SeverityButtonGroup({
  value,
  onChange,
}: {
  value: AlertSeverity;
  onChange: (v: AlertSeverity) => void;
}) {
  useTranslation("policies");
  const severityOptions = createSeverityOptions();
  return (
    <div className="flex flex-wrap gap-2">
      {severityOptions.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium transition ${
            value === opt.value
              ? "border-primary bg-primary/10 text-foreground"
              : "border-muted bg-background text-muted-foreground hover:bg-muted"
          }`}
        >
          <span className={`h-2.5 w-2.5 rounded-full ${opt.color}`} />
          {opt.label}
        </button>
      ))}
    </div>
  );
}
function MonitoringSection({
  icon,
  title,
  count,
  description,
  defaultOpen,
  onAdd,
  addLabel,
  children,
}: {
  icon: ReactNode;
  title: string;
  count: number;
  description: string;
  defaultOpen?: boolean;
  onAdd: () => void;
  addLabel: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen ?? count > 0);
  const panelId = useId();
  return (
    <div className="rounded-lg border bg-card overflow-hidden">
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => handleToggleKeyDown(event, () => setOpen(!open))}
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/30 transition"
      >
        {open ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted/60">
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold">{title}</span>
            {count > 0 && (
              <span className="inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-primary/10 px-1.5 text-xs font-medium text-primary">
                {count}
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            if (!open) setOpen(true);
            onAdd();
          }}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium text-primary transition hover:bg-primary/10"
        >
          <Plus className="h-3.5 w-3.5" />
          {addLabel}
        </button>
      </div>

      {open && (
        <div id={panelId} className="border-t px-4 py-3">
          {children}
        </div>
      )}
    </div>
  );
}
function EmptyState({
  icon,
  message,
  hint,
}: {
  icon: ReactNode;
  message: string;
  hint: string;
}) {
  useTranslation("policies");
  return (
    <div className="rounded-md border border-dashed bg-muted/20 px-4 py-8 text-center">
      <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-muted/40">
        {icon}
      </div>
      <p className="mt-2 text-sm text-muted-foreground">{message}</p>
      <p className="text-xs text-muted-foreground/70">{hint}</p>
    </div>
  );
}
// ============================================
// Main Component
// ============================================
export default function MonitoringTab({
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
  const [settings, setSettings] = useState<MonitoringSettings>(() =>
    readSettings(effectiveLink?.inlineSettings, defaults),
  );
  // Expanded item tracking: "watches:0"
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const legacyAlertRules = legacyAlertRuleCount(effectiveLink?.inlineSettings);
  const nameInputRef = useRef<HTMLInputElement>(null);
  // Known services for autocomplete
  const [knownServices, setKnownServices] = useState<KnownService[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetchWithAuth("/monitoring/known-services?limit=500")
      .then(async (res) => {
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (!cancelled && Array.isArray(data.data)) {
          setKnownServices(data.data);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    const link = existingLink ?? parentLink;
    if (link?.inlineSettings) {
      setSettings((prev) => readSettings(link.inlineSettings, prev));
    }
  }, [existingLink, parentLink]);
  // Focus name input when an item expands
  useEffect(() => {
    if (expandedKey !== null) {
      const t = setTimeout(() => nameInputRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [expandedKey]);
  const toggleExpand = (key: string) =>
    setExpandedKey((prev) => (prev === key ? null : key));
  // ---- Watch CRUD ----
  const updateWatch = (index: number, patch: Partial<WatchEntry>) => {
    setSettings((prev) => ({
      ...prev,
      watches: prev.watches.map((w, i) =>
        i === index ? { ...w, ...patch } : w,
      ),
    }));
  };
  const addWatch = (entry?: Partial<WatchEntry>) => {
    setSettings((prev) => ({
      ...prev,
      watches: [...prev.watches, { ...defaultWatch, ...entry }],
    }));
    setExpandedKey(`watches:${settings.watches.length}`);
  };
  const removeWatch = (index: number) => {
    setSettings((prev) => ({
      ...prev,
      watches: prev.watches.filter((_, i) => i !== index),
    }));
    if (expandedKey === `watches:${index}`) setExpandedKey(null);
  };
  // ---- Save / Remove / Override / Revert ----
  const handleSave = async () => {
    clearError();
    const result = await save(existingLink?.id ?? null, {
      featureType: "monitoring",
      featurePolicyId: linkedPolicyId,
      inlineSettings: settings,
    });
    if (result) onLinkChanged(result, "monitoring");
  };
  const handleRemove = async () => {
    if (!existingLink) return;
    const ok = await remove(existingLink.id);
    if (ok) onLinkChanged(null, "monitoring");
  };
  const handleOverride = async () => {
    clearError();
    const result = await save(null, {
      featureType: "monitoring",
      featurePolicyId: linkedPolicyId,
      inlineSettings: settings,
    });
    if (result) onLinkChanged(result, "monitoring");
  };
  const handleRevert = async () => {
    if (!existingLink) return;
    const ok = await remove(existingLink.id);
    if (ok) onLinkChanged(null, "monitoring");
  };
  const meta = FEATURE_META.monitoring;
  return (
    <FeatureTabShell
      title={meta.label}
      description={meta.description}
      icon={<Activity className="h-5 w-5" />}
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
      {/* ── General Settings ── */}
      <div className="rounded-lg border bg-muted/20 p-4">
        <div className="flex items-center gap-2 mb-3">
          <Settings2 className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">
            {i18n.t(
              "policies:configurationPolicies.featureTabs.monitoringTab.general",
            )}
          </h3>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="text-xs font-medium text-muted-foreground">
              {i18n.t(
                "policies:configurationPolicies.featureTabs.monitoringTab.checkInterval",
              )}
            </label>
            <p className="text-[10px] text-muted-foreground/70">
              {i18n.t(
                "policies:configurationPolicies.featureTabs.monitoringTab.howOftenTheAgentChecksWatchedServices",
              )}
            </p>
            <div className="mt-1.5 flex items-center gap-2">
              <input
                type="number"
                min={10}
                max={3600}
                value={settings.checkIntervalSeconds}
                onChange={(e) =>
                  setSettings((prev) => ({
                    ...prev,
                    checkIntervalSeconds: Math.max(
                      10,
                      Math.min(3600, Number(e.target.value) || 60),
                    ),
                  }))
                }
                className="h-9 w-24 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              />
              <span className="text-sm text-muted-foreground">
                {i18n.t(
                  "policies:configurationPolicies.featureTabs.monitoringTab.seconds",
                )}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* ── Service & Process Watches ── */}
      <div className="mt-4">
        <MonitoringSection
          icon={<Server className="h-4 w-4 text-muted-foreground" />}
          title={i18n.t(
            "policies:configurationPolicies.featureTabs.monitoringTab.serviceProcessWatches",
          )}
          count={settings.watches.length}
          description={i18n.t(
            "policies:configurationPolicies.featureTabs.monitoringTab.monitorRunningServicesAndProcessesAlertOn",
          )}
          onAdd={() => addWatch()}
          addLabel={i18n.t(
            "policies:configurationPolicies.featureTabs.monitoringTab.addWatch",
          )}
        >
          {settings.watches.length === 0 ? (
            <EmptyState
              icon={<Activity className="h-5 w-5 text-muted-foreground/50" />}
              message={i18n.t(
                "policies:configurationPolicies.featureTabs.monitoringTab.noWatchesConfiguredYet",
              )}
              hint={i18n.t(
                "policies:configurationPolicies.featureTabs.monitoringTab.addAServiceOrProcessToStart",
              )}
            />
          ) : (
            <div className="space-y-2">
              {settings.watches.map((watch, idx) => (
                <WatchCard
                  key={idx}
                  watch={watch}
                  knownServices={knownServices}
                  expanded={expandedKey === `watches:${idx}`}
                  onToggle={() => toggleExpand(`watches:${idx}`)}
                  onChange={(patch) => updateWatch(idx, patch)}
                  onRemove={() => removeWatch(idx)}
                  nameInputRef={
                    expandedKey === `watches:${idx}` ? nameInputRef : undefined
                  }
                />
              ))}
            </div>
          )}
        </MonitoringSection>
      </div>

      {/* ── Legacy rules this tab no longer owns (non-blocking) ── */}
      {legacyAlertRules > 0 && (
        <div
          data-testid="monitoring-legacy-alert-rules-notice"
          className="mt-4 flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-700"
        >
          <Bell className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {i18n.t(
              "policies:configurationPolicies.featureTabs.monitoringTab.legacyAlertRulesMovedToAlerts",
              { count: legacyAlertRules },
            )}{" "}
            <button
              type="button"
              data-testid="monitoring-legacy-alert-rules-link"
              onClick={goToAlertsTab}
              className="font-medium underline underline-offset-2 hover:no-underline"
            >
              {i18n.t(
                "policies:configurationPolicies.featureTabs.monitoringTab.openAlertsFeature",
              )}{" "}
              →
            </button>
          </span>
        </div>
      )}

      {/* ── Pointer: server-evaluated alerting lives in the Alerts feature ── */}
      <div className="mt-4">
        <div
          data-testid="monitoring-alerts-pointer"
          className="flex items-start gap-3 rounded-lg border border-dashed bg-muted/20 px-4 py-3"
        >
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted/60">
            <Bell className="h-4 w-4 text-muted-foreground" />
          </div>
          <p className="text-sm text-muted-foreground">
            {i18n.t(
              "policies:configurationPolicies.featureTabs.monitoringTab.deviceThresholdsAndEventLogAlertsPointer",
            )}{" "}
            <button
              type="button"
              data-testid="monitoring-alerts-pointer-link"
              onClick={goToAlertsTab}
              className="font-medium text-primary underline underline-offset-2 hover:no-underline"
            >
              {i18n.t(
                "policies:configurationPolicies.featureTabs.monitoringTab.openAlertsFeature",
              )}{" "}
              →
            </button>
          </p>
        </div>
      </div>
    </FeatureTabShell>
  );
}
// ============================================
// Watch Card
// ============================================
function WatchCard({
  watch,
  knownServices,
  expanded,
  onToggle,
  onChange,
  onRemove,
  nameInputRef,
}: {
  watch: WatchEntry;
  knownServices: KnownService[];
  expanded: boolean;
  onToggle: () => void;
  onChange: (patch: Partial<WatchEntry>) => void;
  onRemove: () => void;
  nameInputRef?: React.RefObject<HTMLInputElement | null>;
}) {
  const panelId = useId();
  const summaryParts: string[] = [];
  if (watch.alertOnStop)
    summaryParts.push(
      i18n.t(
        "policies:configurationPolicies.featureTabs.monitoringTab.alertOnStop2",
      ),
    );
  if (watch.autoRestart)
    summaryParts.push(
      i18n.t(
        "policies:configurationPolicies.featureTabs.monitoringTab.autoRestart2",
      ),
    );
  summaryParts.push(`${watch.alertAfterConsecutiveFailures} failures`);
  return (
    <div className="rounded-md border bg-background">
      {/* Header */}
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={onToggle}
        onKeyDown={(event) => handleToggleKeyDown(event, onToggle)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
      >
        {expanded ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted/60">
          {watch.watchType === "service" ? (
            <Server className="h-3.5 w-3.5 text-muted-foreground" />
          ) : (
            <Cpu className="h-3.5 w-3.5 text-muted-foreground" />
          )}
        </div>
        <span className="text-sm font-medium truncate">
          {watch.name || (
            <span className="italic text-muted-foreground">
              {i18n.t(
                "policies:configurationPolicies.featureTabs.monitoringTab.unnamedWatch",
              )}
            </span>
          )}
        </span>
        <span className="shrink-0 inline-flex items-center rounded-full border bg-muted/40 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
          {watch.watchType}
        </span>
        <SeverityPill severity={watch.alertSeverity} />
        <span className="hidden sm:inline text-xs text-muted-foreground truncate">
          {summaryParts.join(", ")}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onChange({ enabled: !watch.enabled });
            }}
            className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition ${watch.enabled ? "bg-emerald-500/80" : "bg-muted"}`}
          >
            <span
              className={`inline-block h-4 w-4 rounded-full bg-white transition ${watch.enabled ? "translate-x-4" : "translate-x-0.5"}`}
            />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-destructive hover:bg-destructive/10"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Expanded form */}
      {expanded && (
        <div id={panelId} className="border-t px-4 py-3 space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground">
                {i18n.t("common:labels.type")}
              </label>
              <select
                value={watch.watchType}
                onChange={(e) =>
                  onChange({ watchType: e.target.value as WatchType })
                }
                className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              >
                <option value="service">
                  {i18n.t(
                    "policies:configurationPolicies.featureTabs.monitoringTab.service",
                  )}
                </option>
                <option value="process">
                  {i18n.t(
                    "policies:configurationPolicies.featureTabs.monitoringTab.process",
                  )}
                </option>
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">
                {i18n.t("common:labels.name")}
              </label>
              <ServiceNameAutocomplete
                value={watch.name}
                onChange={(name) => onChange({ name })}
                placeholder={
                  watch.watchType === "service"
                    ? i18n.t(
                        "policies:configurationPolicies.featureTabs.monitoringTab.eGNginxSshd",
                      )
                    : i18n.t(
                        "policies:configurationPolicies.featureTabs.monitoringTab.eGNodeJava",
                      )
                }
                knownServices={knownServices}
                inputRef={nameInputRef}
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">
                {i18n.t(
                  "policies:configurationPolicies.featureTabs.monitoringTab.displayName",
                )}
              </label>
              <input
                value={watch.displayName ?? ""}
                onChange={(e) =>
                  onChange({ displayName: e.target.value || undefined })
                }
                placeholder={i18n.t(
                  "policies:configurationPolicies.featureTabs.monitoringTab.friendlyLabelOptional",
                )}
                className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              />
            </div>
          </div>

          {/* Severity */}
          <div>
            <label className="text-xs font-medium text-muted-foreground">
              {i18n.t(
                "policies:configurationPolicies.featureTabs.monitoringTab.alertSeverity",
              )}
            </label>
            <div className="mt-1.5">
              <SeverityButtonGroup
                value={watch.alertSeverity}
                onChange={(v) => onChange({ alertSeverity: v })}
              />
            </div>
          </div>

          {/* Alert settings */}
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={watch.alertOnStop}
                onChange={(e) => onChange({ alertOnStop: e.target.checked })}
                className="h-4 w-4 rounded border"
              />
              <label className="text-xs font-medium">
                {i18n.t(
                  "policies:configurationPolicies.featureTabs.monitoringTab.alertOnStop",
                )}
              </label>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">
                {i18n.t(
                  "policies:configurationPolicies.featureTabs.monitoringTab.consecutiveFailures",
                )}
              </label>
              <input
                type="number"
                min={1}
                max={100}
                value={watch.alertAfterConsecutiveFailures}
                onChange={(e) =>
                  onChange({
                    alertAfterConsecutiveFailures: Math.max(
                      1,
                      Math.min(100, Number(e.target.value) || 2),
                    ),
                  })
                }
                className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              />
            </div>
          </div>

          {/* Process thresholds */}
          {watch.watchType === "process" && (
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground">
                  {i18n.t(
                    "policies:configurationPolicies.featureTabs.monitoringTab.cPUThreshold",
                  )}
                </label>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={watch.cpuThresholdPercent ?? ""}
                  onChange={(e) =>
                    onChange({
                      cpuThresholdPercent: e.target.value
                        ? Number(e.target.value)
                        : undefined,
                    })
                  }
                  placeholder={i18n.t("common:labels.none")}
                  className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">
                  {i18n.t(
                    "policies:configurationPolicies.featureTabs.monitoringTab.memoryThresholdMB",
                  )}
                </label>
                <input
                  type="number"
                  min={0}
                  value={watch.memoryThresholdMb ?? ""}
                  onChange={(e) =>
                    onChange({
                      memoryThresholdMb: e.target.value
                        ? Number(e.target.value)
                        : undefined,
                    })
                  }
                  placeholder={i18n.t("common:labels.none")}
                  className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">
                  {i18n.t(
                    "policies:configurationPolicies.featureTabs.monitoringTab.thresholdDurationS",
                  )}
                </label>
                <input
                  type="number"
                  min={0}
                  max={86400}
                  value={watch.thresholdDurationSeconds}
                  onChange={(e) =>
                    onChange({
                      thresholdDurationSeconds: Math.max(
                        0,
                        Math.min(86400, Number(e.target.value) || 300),
                      ),
                    })
                  }
                  className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                />
              </div>
            </div>
          )}

          {/* Auto-restart */}
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={watch.autoRestart}
                onChange={(e) => onChange({ autoRestart: e.target.checked })}
                className="h-4 w-4 rounded border"
              />
              <label className="text-xs font-medium">
                {i18n.t(
                  "policies:configurationPolicies.featureTabs.monitoringTab.autoRestart",
                )}
              </label>
            </div>
            {watch.autoRestart && (
              <>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">
                    {i18n.t(
                      "policies:configurationPolicies.featureTabs.monitoringTab.maxRestartAttempts",
                    )}
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={50}
                    value={watch.maxRestartAttempts}
                    onChange={(e) =>
                      onChange({
                        maxRestartAttempts: Math.max(
                          0,
                          Math.min(50, Number(e.target.value) || 3),
                        ),
                      })
                    }
                    className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">
                    {i18n.t(
                      "policies:configurationPolicies.featureTabs.monitoringTab.cooldownSeconds",
                    )}
                  </label>
                  <input
                    type="number"
                    min={30}
                    max={86400}
                    value={watch.restartCooldownSeconds}
                    onChange={(e) =>
                      onChange({
                        restartCooldownSeconds: Math.max(
                          30,
                          Math.min(86400, Number(e.target.value) || 300),
                        ),
                      })
                    }
                    className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  />
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
// ============================================
// Service Name Autocomplete
// ============================================
function ServiceNameAutocomplete({
  value,
  onChange,
  placeholder,
  knownServices,
  inputRef,
}: {
  value: string;
  onChange: (name: string) => void;
  placeholder: string;
  knownServices: KnownService[];
  inputRef?: React.RefObject<HTMLInputElement | null>;
}) {
  const [open, setOpen] = useState(false);
  const [inputValue, setInputValue] = useState(value);
  const wrapperRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setInputValue(value);
  }, [value]);
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        wrapperRef.current &&
        !wrapperRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);
  const filtered = inputValue
    ? knownServices
        .filter((s) => s.name.toLowerCase().includes(inputValue.toLowerCase()))
        .slice(0, 15)
    : knownServices.slice(0, 15);
  const handleSelect = (name: string) => {
    setInputValue(name);
    onChange(name);
    setOpen(false);
  };
  return (
    <div ref={wrapperRef} className="relative">
      <input
        ref={inputRef}
        value={inputValue}
        onChange={(e) => {
          setInputValue(e.target.value);
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder={placeholder}
        className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
        autoComplete="off"
      />
      {open && filtered.length > 0 && (
        <div className="absolute z-50 mt-1 max-h-48 w-full overflow-y-auto rounded-md border bg-popover shadow-md">
          {filtered.map((svc) => (
            <button
              key={svc.name}
              type="button"
              onClick={() => handleSelect(svc.name)}
              className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-muted/60"
            >
              <span className="truncate">{svc.name}</span>
              <span className="ml-2 shrink-0 text-[10px] text-muted-foreground">
                {svc.source === "check_results"
                  ? i18n.t(
                      "policies:configurationPolicies.featureTabs.monitoringTab.monitored",
                    )
                  : i18n.t(
                      "policies:configurationPolicies.featureTabs.monitoringTab.inventory",
                    )}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
