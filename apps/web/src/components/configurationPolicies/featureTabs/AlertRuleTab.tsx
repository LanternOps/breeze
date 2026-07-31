import { useState, useEffect, useRef, useId } from "react";
import {
  Bell,
  Plus,
  Trash2,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
} from "lucide-react";
import type { FeatureTabProps } from "./types";
import { FEATURE_META } from "./types";
import { useFeatureLink } from "./useFeatureLink";
import { handleToggleKeyDown } from "./disclosureKeyboard";
import FeatureTabShell from "./FeatureTabShell";
import { useTranslation } from "react-i18next";
import { i18n } from "@/lib/i18n";
// The exact metric-name domain the API threshold evaluator resolves
// (METRIC_NAME_MAP in apps/api/src/services/alertConditions/utils.ts). Imported
// rather than re-listed so this editor's idea of "evaluable" cannot drift from
// the schema that accepts the save.
// (root entry, not the /validators subpath — only the bare specifier is mapped
// in apps/web/tsconfig.json and vitest.config.ts).
import { ALERT_METRIC_NAMES } from "@breeze/shared";
// `offline` is the type understood by the API condition evaluator. The legacy
// editor emitted `status` with a `duration` field; we normalize those on load
// (see normalizeConditions) and always emit the `offline`/`durationMinutes`
// shape on save so rules actually evaluate (issue #1857).
//
// `event_log` arrived with the 2026-07-30 alert consolidation: event log alert
// rules used to live in the Monitoring feature's inline settings and are now
// ordinary alert-rule conditions owned by this tab.
//
// `custom` was removed: the API condition evaluator has no handler for it, so a
// `custom` condition never fired, and the canonical write schema now rejects it.
type ConditionType = "metric" | "offline" | "event_log";
const EDITABLE_CONDITION_TYPES: readonly ConditionType[] = [
  "metric",
  "offline",
  "event_log",
];
function isEditableConditionType(type: string): type is ConditionType {
  return (EDITABLE_CONDITION_TYPES as readonly string[]).includes(type);
}
type EventLogCategory = "security" | "hardware" | "application" | "system";
type EventLogLevel = "warning" | "error" | "critical";
type AlertSeverity = "critical" | "high" | "medium" | "low" | "info";
// `type` is deliberately a plain string: rows saved before this editor existed
// can carry condition types it no longer offers (`custom`, `bandwidth_high`,
// `disk_io_high`, `network_errors`, `patch_compliance`, `cert_expiry`). Those
// are rendered read-only and preserved verbatim in tab state — but the server
// REJECTS them on save, so the rule carrying one cannot be saved at all until
// the offending condition is removed. That is why they get an amber banner
// rather than being quietly round-tripped.
type Condition = {
  type: string;
  metric?: string;
  operator?: string;
  value?: number;
  durationMinutes?: number;
  category?: EventLogCategory;
  level?: EventLogLevel;
  sourcePattern?: string;
  messagePattern?: string;
  countThreshold?: number;
  windowMinutes?: number;
};
// The fields below `autoResolve` have no control in this editor but ARE part of
// the stored rule (alertRuleItemSchema in @breeze/shared, and columns on
// config_policy_alert_rules). They are declared so `{...item, ...patch}` in
// updateItem keeps them in the save payload — an unrelated severity tweak must
// not silently reset a rule's custom title/message templates or its sort order.
type AlertItem = {
  name: string;
  severity: AlertSeverity;
  conditions: Condition[];
  cooldownMinutes: number;
  autoResolve: boolean;
  autoResolveConditions?: Condition[] | null;
  titleTemplate?: string;
  messageTemplate?: string;
  sortOrder?: number;
};
const defaultItem: AlertItem = {
  name: "",
  severity: "medium",
  conditions: [{ type: "metric", metric: "cpu", operator: "gt", value: 80 }],
  cooldownMinutes: 15,
  autoResolve: false,
};
const createSeverityOptions = (): {
  value: AlertSeverity;
  label: string;
  color: string;
}[] => [
  {
    value: "critical",
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.alertRuleTab.critical",
    ),
    color: "bg-red-500",
  },
  {
    value: "high",
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.alertRuleTab.high",
    ),
    color: "bg-orange-500",
  },
  {
    value: "medium",
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.alertRuleTab.medium",
    ),
    color: "bg-yellow-500",
  },
  {
    value: "low",
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.alertRuleTab.low",
    ),
    color: "bg-blue-500",
  },
  {
    value: "info",
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.alertRuleTab.info",
    ),
    color: "bg-gray-500",
  },
];
// Only metrics with a percentage column in device_metrics that the API
// threshold evaluator (METRIC_NAME_MAP) understands. "Network Usage" was
// removed: there is no network-usage percentage column to compare against,
// so the option never fired (issue #1857). Bandwidth alerting has its own
// dedicated condition type and is not exposed via this simple % dropdown.
const createMetricOptions = () => [
  {
    value: "cpu",
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.alertRuleTab.cPUUsage",
    ),
  },
  {
    value: "ram",
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.alertRuleTab.memoryUsage",
    ),
  },
  {
    value: "disk",
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.alertRuleTab.diskUsage",
    ),
  },
];
const createOperatorOptions = () => [
  {
    value: "gt",
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.alertRuleTab.greaterThan",
    ),
  },
  {
    value: "lt",
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.alertRuleTab.lessThan",
    ),
  },
  {
    value: "gte",
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.alertRuleTab.greaterOrEqual",
    ),
  },
  {
    value: "lte",
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.alertRuleTab.lessOrEqual",
    ),
  },
  {
    value: "eq",
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.alertRuleTab.equal",
    ),
  },
  {
    value: "neq",
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.alertRuleTab.notEqual",
    ),
  },
];
const createConditionTypeOptions = (): {
  value: ConditionType;
  label: string;
}[] => [
  {
    value: "metric",
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.alertRuleTab.metric",
    ),
  },
  {
    value: "offline",
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.alertRuleTab.deviceOffline",
    ),
  },
  {
    value: "event_log",
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.alertRuleTab.eventLog",
    ),
  },
];
const createEventCategoryOptions = (): {
  value: EventLogCategory;
  label: string;
}[] => [
  {
    value: "security",
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.alertRuleTab.security",
    ),
  },
  {
    value: "hardware",
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.alertRuleTab.hardware",
    ),
  },
  {
    value: "application",
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.alertRuleTab.application",
    ),
  },
  {
    value: "system",
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.alertRuleTab.system",
    ),
  },
];
const createEventLevelOptions = (): {
  value: EventLogLevel;
  label: string;
}[] => [
  {
    value: "warning",
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.alertRuleTab.warning",
    ),
  },
  {
    value: "error",
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.alertRuleTab.error",
    ),
  },
  {
    value: "critical",
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.alertRuleTab.critical",
    ),
  },
];
// Mirrors eventLogConditionSchema in @breeze/shared: countThreshold 1-10000,
// windowMinutes 1-1440. Clamped here so the field can't be set out of range.
const EVENT_LOG_COUNT_MAX = 10000;
const EVENT_LOG_WINDOW_MAX_MINUTES = 1440;
// Seed values applied when a condition's type is switched, so the new shape is
// immediately valid against the canonical write schema.
const conditionDefaults: Record<ConditionType, Condition> = {
  metric: { type: "metric", metric: "cpu", operator: "gt", value: 80 },
  offline: { type: "offline", durationMinutes: 5 },
  event_log: {
    type: "event_log",
    category: "security",
    level: "error",
    countThreshold: 1,
    windowMinutes: 15,
  },
};
// Offline rules are re-evaluated by a background sweep bounded to a 24h horizon,
// so a rule with a longer duration would never fire — the device ages out of the
// sweep first. The API rejects durations above this cap (issue #1982); mirror it
// here so the field can't be set out of range. Matches the default
// OFFLINE_DETECTOR_REEVAL_HORIZON_MINUTES on the API.
const OFFLINE_DURATION_MAX_MINUTES = 1440;
// Metric aliases the API accepts (METRIC_NAME_MAP in the evaluator, mirrored by
// ALERT_METRIC_NAMES in @breeze/shared) mapped onto the short name this dropdown
// offers. Normalizing on LOAD — rather than adding hidden dropdown options — is
// the pattern chosen here: it keeps exactly one canonical spelling in the editor
// and in anything the editor saves, and every alias below is a pure synonym
// (`cpuPercent` and `cpu` both resolve to device_metrics.cpu_percent), so the
// rewrite is lossless. Metrics with no dropdown entry (processCount/processes)
// are NOT rewritten; they get a fallback <option> instead so the select shows
// what is really stored rather than silently displaying "CPU Usage".
const METRIC_ALIAS_TO_OPTION: Record<string, string> = {
  cpuPercent: "cpu",
  ramPercent: "ram",
  memory: "ram",
  diskPercent: "disk",
};
// A metric name the evaluator cannot resolve (the retired "network" option is
// the known producer — normalizeMetricName returns null for it, so the rule has
// never fired) and that the write schema now rejects. Such a condition is
// rendered read-only and banner-flagged: silently editable would let one
// unrelated tweak trigger a save the server rejects with no explanation.
function isSupportedMetric(metric: string | undefined): boolean {
  return (
    typeof metric === "string"
    && (ALERT_METRIC_NAMES as readonly string[]).includes(metric)
  );
}
// Value bounds are metric-dependent: cpu/ram/disk are percentages, but
// processCount is a raw count and capping it at 100 silently rewrote any
// "more than 250 processes" rule the AI tool had written. undefined = no cap.
const METRIC_VALUE_MAX: Record<string, number | undefined> = {
  cpu: 100, cpuPercent: 100,
  ram: 100, ramPercent: 100, memory: 100,
  disk: 100, diskPercent: 100,
  processCount: undefined, processes: undefined,
};
function metricValueMax(metric: string | undefined): number | undefined {
  return metric ? METRIC_VALUE_MAX[metric] : 100;
}
// Migrate a single condition from the legacy `{type:'status', duration}` shape
// to the canonical `{type:'offline', durationMinutes}` shape the evaluator reads.
// Legacy persisted shape, before the `status`→`offline` / `duration`→`durationMinutes` rename.
type RawCondition = Condition & { duration?: number };
function normalizeCondition(condition: Condition): Condition {
  const raw = condition as RawCondition;
  if (raw.type === "status" || raw.type === "offline") {
    const { duration, durationMinutes, ...rest } = raw;
    return {
      ...rest,
      type: "offline",
      durationMinutes: durationMinutes ?? duration ?? 5,
    };
  }
  // `threshold` is the evaluator's own name for the metric handler
  // (handlers/threshold.ts, aliases ['metric']) and the pre-consolidation AI
  // tool docs advertised it, so stored rows carry it. Fold it into `metric`
  // exactly as `status` folds into `offline` — otherwise the editor would show
  // it as a retired, un-editable type when the server happily accepts it.
  if (raw.type === "metric" || raw.type === "threshold") {
    const canonical = raw.metric ? METRIC_ALIAS_TO_OPTION[raw.metric] : undefined;
    // `duration` (seconds) was never read by the metric evaluator; drop it so it
    // can't be mistaken for a sustained window. `durationMinutes` IS honoured
    // and is round-tripped untouched.
    const { duration, ...rest } = raw;
    // Deliberately NO fallback for a missing metric name. A metric condition
    // with no metric is exactly as dead as one naming "network"
    // (normalizeMetricName(undefined) → null), and
    // 2026-07-30-b-drop-never-firing-metric-alert-rules.sql deletes both as
    // never-firing — defaulting it to "cpu" here would resurrect
    // it as a live CPU rule on the next save. isEditableCondition() already
    // returns false for it, so it gets the honest read-only + banner treatment.
    const metric = canonical ?? rest.metric;
    // Don't materialize a `metric: undefined` key that wasn't there.
    return metric === undefined
      ? { ...rest, type: "metric" }
      : { ...rest, type: "metric", metric };
  }
  // Every other type — including types this editor no longer offers — is
  // returned untouched so an unrelated edit elsewhere in the rule can't strip
  // fields off it.
  return condition;
}
function normalizeConditions(item: AlertItem): AlertItem {
  if (!Array.isArray(item.conditions)) {
    return { ...item, conditions: [...defaultItem.conditions] };
  }
  return { ...item, conditions: item.conditions.map(normalizeCondition) };
}
function loadItems(existingLink: FeatureTabProps["existingLink"]): AlertItem[] {
  const raw = existingLink?.inlineSettings as
    | Record<string, unknown>
    | null
    | undefined;
  if (!raw) return [];
  if (Array.isArray((raw as any).items)) {
    return ((raw as any).items as AlertItem[]).map(normalizeConditions);
  }
  // Legacy single-item format — wrap it
  if ((raw as any).severity) {
    const legacy = raw as unknown as Omit<AlertItem, "name">;
    return [normalizeConditions({ ...legacy, name: "Alert Rule 1" })];
  }
  return [];
}
// A condition this editor can render a form for. Two ways to fail: a condition
// TYPE it no longer offers, or a metric NAME the evaluator cannot resolve. Both
// are rejected by the write schema, so both must be surfaced rather than left
// looking editable.
function isEditableCondition(condition: Condition): boolean {
  if (!isEditableConditionType(condition.type)) return false;
  if (condition.type === "metric") return isSupportedMetric(condition.metric);
  return true;
}
// Condition types the editor can no longer render a form for. Listed on the rule
// so the tech knows why a save is being rejected and what to remove.
function unsupportedConditionTypes(item: AlertItem): string[] {
  return [
    ...new Set(
      item.conditions
        .map((c) => c.type)
        .filter((type) => !isEditableConditionType(type)),
    ),
  ];
}
// A metric condition can also carry NO metric at all — just as dead, and it has
// to be nameable in the banner rather than silently omitted from it.
function displayMetricName(metric: string | undefined): string {
  return metric && metric.length > 0
    ? metric
    : i18n.t("policies:configurationPolicies.featureTabs.alertRuleTab.metricNotSet");
}
// Metric names outside the evaluator's domain, e.g. the retired "network"
// option the old Monitoring tab offered. Reported separately from retired TYPES
// because the remedy differs: pick a supported metric, rather than delete the
// whole condition.
function unsupportedConditionMetrics(item: AlertItem): string[] {
  return [
    ...new Set(
      item.conditions
        .filter((c) => c.type === "metric" && !isSupportedMetric(c.metric))
        .map((c) => displayMetricName(c.metric)),
    ),
  ];
}
function severityPill(severity: AlertSeverity) {
  const opt = createSeverityOptions().find((o) => o.value === severity);
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium">
      <span className={`h-2 w-2 rounded-full ${opt?.color ?? "bg-gray-400"}`} />
      {opt?.label ?? severity}
    </span>
  );
}
export default function AlertRuleTab({
  policyId,
  existingLink,
  onLinkChanged,
  linkedPolicyId,
  parentLink,
}: FeatureTabProps) {
  useTranslation("policies");
  const severityOptions = createSeverityOptions();
  const metricOptions = createMetricOptions();
  const operatorOptions = createOperatorOptions();
  const conditionTypeOptions = createConditionTypeOptions();
  const eventCategoryOptions = createEventCategoryOptions();
  const eventLevelOptions = createEventLevelOptions();
  const { save, remove, saving, error, clearError } = useFeatureLink(policyId);
  const isInherited = !!parentLink && !existingLink;
  const effectiveLink = existingLink ?? parentLink;
  const [items, setItems] = useState<AlertItem[]>(() =>
    loadItems(effectiveLink),
  );
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  // Stable per-instance prefix for the expanded-panel ids each card header
  // points at via aria-controls.
  const cardIdPrefix = useId();
  useEffect(() => {
    setItems(loadItems(existingLink ?? parentLink));
  }, [existingLink, parentLink]);
  // Focus name input when a new item is expanded
  useEffect(() => {
    if (expandedIndex !== null) {
      // Small delay to let DOM render
      const t = setTimeout(() => nameInputRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [expandedIndex]);
  const updateItem = (index: number, patch: Partial<AlertItem>) => {
    setItems((prev) =>
      prev.map((item, i) => (i === index ? { ...item, ...patch } : item)),
    );
  };
  const updateCondition = (
    itemIndex: number,
    condIndex: number,
    patch: Partial<Condition>,
  ) => {
    setItems((prev) =>
      prev.map((item, i) => {
        if (i !== itemIndex) return item;
        const conditions = item.conditions.map((c, ci) =>
          ci === condIndex ? { ...c, ...patch } : c,
        );
        return { ...item, conditions };
      }),
    );
  };
  // Switching a condition's type swaps in that type's seed values rather than
  // merging, so no stale field from the previous shape is left behind.
  const changeConditionType = (
    itemIndex: number,
    condIndex: number,
    type: ConditionType,
  ) => {
    setItems((prev) =>
      prev.map((item, i) => {
        if (i !== itemIndex) return item;
        const conditions = item.conditions.map((c, ci) =>
          ci === condIndex ? { ...conditionDefaults[type] } : c,
        );
        return { ...item, conditions };
      }),
    );
  };
  const addCondition = (itemIndex: number) => {
    setItems((prev) =>
      prev.map((item, i) => {
        if (i !== itemIndex) return item;
        return {
          ...item,
          conditions: [...item.conditions, { ...conditionDefaults.metric }],
        };
      }),
    );
  };
  const removeCondition = (itemIndex: number, condIndex: number) => {
    setItems((prev) =>
      prev.map((item, i) => {
        if (i !== itemIndex) return item;
        return {
          ...item,
          conditions: item.conditions.filter((_, ci) => ci !== condIndex),
        };
      }),
    );
  };
  const addItem = () => {
    const newItem: AlertItem = {
      ...defaultItem,
      name: `Alert Rule ${items.length + 1}`,
      conditions: [{ ...defaultItem.conditions[0] }],
    };
    setItems((prev) => [...prev, newItem]);
    setExpandedIndex(items.length);
  };
  const deleteItem = (index: number) => {
    setItems((prev) => prev.filter((_, i) => i !== index));
    if (expandedIndex === index) setExpandedIndex(null);
    else if (expandedIndex !== null && expandedIndex > index)
      setExpandedIndex(expandedIndex - 1);
  };
  const handleSave = async () => {
    clearError();
    const result = await save(existingLink?.id ?? null, {
      featureType: "alert_rule",
      featurePolicyId: linkedPolicyId,
      inlineSettings: { items },
    });
    if (result) onLinkChanged(result, "alert_rule");
  };
  const handleRemove = async () => {
    if (!existingLink) return;
    const ok = await remove(existingLink.id);
    if (ok) onLinkChanged(null, "alert_rule");
  };
  const handleOverride = async () => {
    clearError();
    const result = await save(null, {
      featureType: "alert_rule",
      featurePolicyId: linkedPolicyId,
      inlineSettings: { items },
    });
    if (result) onLinkChanged(result, "alert_rule");
  };
  const handleRevert = async () => {
    if (!existingLink) return;
    const ok = await remove(existingLink.id);
    if (ok) onLinkChanged(null, "alert_rule");
  };
  const meta = FEATURE_META.alert_rule;
  return (
    <FeatureTabShell
      title={meta.label}
      description={meta.description}
      icon={<Bell className="h-5 w-5" />}
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
      {/* Header with count + Add button */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">
            {i18n.t(
              "policies:configurationPolicies.featureTabs.alertRuleTab.alertRules",
            )}
          </h3>
          {items.length > 0 && (
            <span className="inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-primary/10 px-1.5 text-xs font-medium text-primary">
              {items.length}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={addItem}
          className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
        >
          <Plus className="h-4 w-4" />
          {i18n.t(
            "policies:configurationPolicies.featureTabs.alertRuleTab.addAlertRule",
          )}
        </button>
      </div>

      {/* Empty state */}
      {items.length === 0 && (
        <div className="mt-4 rounded-md border border-dashed p-8 text-center">
          <Bell className="mx-auto h-8 w-8 text-muted-foreground/50" />
          <p className="mt-2 text-sm text-muted-foreground">
            {i18n.t(
              "policies:configurationPolicies.featureTabs.alertRuleTab.noAlertRulesConfiguredYet",
            )}
          </p>
          <button
            type="button"
            onClick={addItem}
            className="mt-3 inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            <Plus className="h-4 w-4" />
            {i18n.t(
              "policies:configurationPolicies.featureTabs.alertRuleTab.addAlertRule2",
            )}
          </button>
        </div>
      )}

      {/* Item cards */}
      <div className="mt-3 space-y-2">
        {items.map((item, index) => {
          const isExpanded = expandedIndex === index;
          const unsupportedTypes = unsupportedConditionTypes(item);
          const unsupportedMetrics = unsupportedConditionMetrics(item);
          const hasUnsupported =
            unsupportedTypes.length > 0 || unsupportedMetrics.length > 0;
          return (
            <div key={index} className="rounded-md border bg-muted/10">
              {/* Collapsed header.
                  role="button" rather than a native <button>: the delete
                  control lives inside the header, and a <button> inside a
                  <button> is invalid HTML that React reports as a hydration
                  error on every expand. Same pattern as MonitoringTab's
                  WatchCard — see disclosureKeyboard.ts. */}
              <div
                role="button"
                tabIndex={0}
                aria-expanded={isExpanded}
                aria-controls={`${cardIdPrefix}-${index}`}
                data-testid={`alert-rule-card-header-${index}`}
                onClick={() => setExpandedIndex(isExpanded ? null : index)}
                onKeyDown={(event) =>
                  handleToggleKeyDown(event, () =>
                    setExpandedIndex(isExpanded ? null : index),
                  )
                }
                className="flex w-full items-center justify-between px-4 py-3 text-left"
              >
                <div className="flex items-center gap-3">
                  {isExpanded ? (
                    <ChevronDown className="h-4 w-4 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  )}
                  <span className="text-sm font-medium">
                    {item.name ||
                      i18n.t(
                        "policies:configurationPolicies.featureTabs.alertRuleTab.untitledRule",
                      )}
                  </span>
                  {severityPill(item.severity)}
                  {hasUnsupported && (
                    <AlertTriangle
                      data-testid={`alert-rule-legacy-flag-${index}`}
                      className="h-4 w-4 shrink-0 text-amber-600"
                    />
                  )}
                  <span className="text-xs text-muted-foreground">
                    {item.conditions.length}
                    {i18n.t(
                      "policies:configurationPolicies.featureTabs.alertRuleTab.condition",
                    )}
                    {item.conditions.length !== 1
                      ? i18n.t(
                          "policies:configurationPolicies.featureTabs.alertRuleTab.s",
                        )
                      : ""}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteItem(index);
                  }}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-destructive hover:bg-destructive/10"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>

              {/* Expanded form */}
              {isExpanded && (
                <div
                  id={`${cardIdPrefix}-${index}`}
                  className="border-t px-4 pb-4 pt-3 space-y-4"
                >
                  {/* Legacy condition warning */}
                  {hasUnsupported && (
                    <div
                      data-testid={`alert-rule-legacy-warning-${index}`}
                      className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700"
                    >
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                      <span className="space-y-1">
                        {unsupportedTypes.length > 0 && (
                          <span className="block">
                            {i18n.t(
                              "policies:configurationPolicies.featureTabs.alertRuleTab.thisRuleUsesRetiredConditionTypes",
                              { types: unsupportedTypes.join(", ") },
                            )}
                          </span>
                        )}
                        {unsupportedMetrics.length > 0 && (
                          <span className="block">
                            {i18n.t(
                              "policies:configurationPolicies.featureTabs.alertRuleTab.thisRuleUsesUnsupportedMetrics",
                              { metrics: unsupportedMetrics.join(", ") },
                            )}
                          </span>
                        )}
                      </span>
                    </div>
                  )}

                  {/* Name */}
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">
                      {i18n.t(
                        "policies:configurationPolicies.featureTabs.alertRuleTab.ruleName",
                      )}
                    </label>
                    <input
                      ref={nameInputRef}
                      value={item.name}
                      onChange={(e) =>
                        updateItem(index, { name: e.target.value })
                      }
                      placeholder={i18n.t(
                        "policies:configurationPolicies.featureTabs.alertRuleTab.eGHighCPUAlert",
                      )}
                      className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                    />
                  </div>

                  {/* Severity */}
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">
                      {i18n.t(
                        "policies:configurationPolicies.featureTabs.alertRuleTab.severity",
                      )}
                    </label>
                    <div className="mt-1.5 flex flex-wrap gap-2">
                      {severityOptions.map((opt) => (
                        <button
                          key={opt.value}
                          type="button"
                          onClick={() =>
                            updateItem(index, { severity: opt.value })
                          }
                          className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium transition ${
                            item.severity === opt.value
                              ? "border-primary bg-primary/10 text-foreground"
                              : "border-muted bg-background text-muted-foreground hover:bg-muted"
                          }`}
                        >
                          <span
                            className={`h-2.5 w-2.5 rounded-full ${opt.color}`}
                          />
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Conditions */}
                  <div>
                    <div className="flex items-center justify-between">
                      <label className="text-xs font-medium text-muted-foreground">
                        {i18n.t(
                          "policies:configurationPolicies.featureTabs.alertRuleTab.conditions",
                        )}
                      </label>
                      <button
                        type="button"
                        onClick={() => addCondition(index)}
                        className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted"
                      >
                        <Plus className="h-3 w-3" />
                        {i18n.t("common:actions.add")}
                      </button>
                    </div>
                    <div className="mt-2 space-y-2">
                      {item.conditions.map((condition, ci) => {
                        const editable = isEditableCondition(condition);
                        // A metric condition is un-editable only because of its
                        // metric NAME — the type itself is fine, so the reason
                        // shown has to say so or the tech goes looking for a
                        // retired type that isn't there.
                        const unsupportedMetric =
                          condition.type === "metric" && !editable
                            ? displayMetricName(condition.metric)
                            : "";
                        return (
                          <div
                            key={ci}
                            data-testid={`alert-rule-${index}-condition-${ci}`}
                            className="rounded-md border bg-muted/20 p-3"
                          >
                            <div className="flex items-start gap-2">
                              <div className="flex-1 grid gap-2 sm:grid-cols-2 md:grid-cols-4">
                                <div>
                                  <label className="text-xs font-medium text-muted-foreground">
                                    {i18n.t("common:labels.type")}
                                  </label>
                                  {editable ? (
                                    <select
                                      value={condition.type}
                                      onChange={(e) =>
                                        changeConditionType(
                                          index,
                                          ci,
                                          e.target.value as ConditionType,
                                        )
                                      }
                                      className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm"
                                    >
                                      {conditionTypeOptions.map((o) => (
                                        <option key={o.value} value={o.value}>
                                          {o.label}
                                        </option>
                                      ))}
                                    </select>
                                  ) : (
                                    <p
                                      data-testid={`alert-rule-${index}-condition-${ci}-readonly-type`}
                                      className="mt-1 flex h-8 items-center truncate rounded-md border border-dashed bg-muted/40 px-2 font-mono text-xs text-muted-foreground"
                                    >
                                      {unsupportedMetric
                                        ? `${condition.type}: ${unsupportedMetric}`
                                        : condition.type}
                                    </p>
                                  )}
                                </div>

                                {!editable && (
                                  <p className="self-center text-xs text-muted-foreground sm:col-span-1 md:col-span-3">
                                    {unsupportedMetric
                                      ? i18n.t(
                                          "policies:configurationPolicies.featureTabs.alertRuleTab.thisConditionUsesAnUnsupportedMetric",
                                          { metric: unsupportedMetric },
                                        )
                                      : i18n.t(
                                          "policies:configurationPolicies.featureTabs.alertRuleTab.thisConditionTypeIsNoLongerEditable",
                                        )}
                                  </p>
                                )}

                                {condition.type === "metric" && editable && (
                                  <>
                                    <div>
                                      <label className="text-xs font-medium text-muted-foreground">
                                        {i18n.t(
                                          "policies:configurationPolicies.featureTabs.alertRuleTab.metric2",
                                        )}
                                      </label>
                                      <select
                                        value={condition.metric ?? "cpu"}
                                        onChange={(e) =>
                                          updateCondition(index, ci, {
                                            metric: e.target.value,
                                          })
                                        }
                                        className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm"
                                      >
                                        {metricOptions.map((o) => (
                                          <option key={o.value} value={o.value}>
                                            {o.label}
                                          </option>
                                        ))}
                                        {/* A stored metric this dropdown does
                                            not offer (processCount, written by
                                            the AI tool) still needs an option,
                                            or the select would display the
                                            first entry while holding a
                                            different value — and one unrelated
                                            edit elsewhere would silently
                                            rewrite the rule to CPU. */}
                                        {condition.metric &&
                                          !metricOptions.some(
                                            (o) => o.value === condition.metric,
                                          ) && (
                                            <option value={condition.metric}>
                                              {condition.metric}
                                            </option>
                                          )}
                                      </select>
                                    </div>
                                    <div>
                                      <label className="text-xs font-medium text-muted-foreground">
                                        {i18n.t(
                                          "policies:configurationPolicies.featureTabs.alertRuleTab.operator",
                                        )}
                                      </label>
                                      <select
                                        value={condition.operator ?? "gt"}
                                        onChange={(e) =>
                                          updateCondition(index, ci, {
                                            operator: e.target.value,
                                          })
                                        }
                                        className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm"
                                      >
                                        {operatorOptions.map((o) => (
                                          <option key={o.value} value={o.value}>
                                            {o.label}
                                          </option>
                                        ))}
                                      </select>
                                    </div>
                                    <div>
                                      <label className="text-xs font-medium text-muted-foreground">
                                        {metricValueMax(condition.metric) === undefined
                                          ? i18n.t(
                                              "policies:configurationPolicies.featureTabs.alertRuleTab.valueCount",
                                            )
                                          : i18n.t(
                                              "policies:configurationPolicies.featureTabs.alertRuleTab.value",
                                            )}
                                      </label>
                                      <input
                                        type="number"
                                        min={0}
                                        max={metricValueMax(condition.metric)}
                                        value={condition.value ?? 80}
                                        onChange={(e) => {
                                          // Clamp the same way the offline
                                          // duration field does, but against a
                                          // metric-aware ceiling: processCount
                                          // is a raw count with no upper bound,
                                          // so a hard 100 would silently
                                          // rewrite "over 250 processes".
                                          const max = metricValueMax(condition.metric);
                                          const raw = Number(e.target.value);
                                          const clamped = Math.max(
                                            0,
                                            max === undefined ? raw : Math.min(max, raw),
                                          );
                                          updateCondition(index, ci, { value: clamped });
                                        }}
                                        className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm"
                                      />
                                    </div>
                                  </>
                                )}

                                {condition.type === "offline" && (
                                  <div className="sm:col-span-3">
                                    <label className="text-xs font-medium text-muted-foreground">
                                      {i18n.t(
                                        "policies:configurationPolicies.featureTabs.alertRuleTab.offlineDurationMin",
                                      )}
                                    </label>
                                    <input
                                      type="number"
                                      min={1}
                                      max={OFFLINE_DURATION_MAX_MINUTES}
                                      value={condition.durationMinutes ?? 5}
                                      onChange={(e) =>
                                        updateCondition(index, ci, {
                                          durationMinutes: Math.min(
                                            OFFLINE_DURATION_MAX_MINUTES,
                                            Math.max(1, Number(e.target.value)),
                                          ),
                                        })
                                      }
                                      className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm"
                                    />
                                    <p className="mt-1 text-[11px] text-muted-foreground">
                                      {i18n.t(
                                        "policies:configurationPolicies.featureTabs.alertRuleTab.max",
                                      )}
                                      {OFFLINE_DURATION_MAX_MINUTES}
                                      {i18n.t(
                                        "policies:configurationPolicies.featureTabs.alertRuleTab.min24hReEvaluationHorizon",
                                      )}
                                    </p>
                                  </div>
                                )}

                                {condition.type === "event_log" && (
                                  <>
                                    <div>
                                      <label className="text-xs font-medium text-muted-foreground">
                                        {i18n.t(
                                          "policies:configurationPolicies.featureTabs.alertRuleTab.eventCategory",
                                        )}
                                      </label>
                                      <select
                                        value={condition.category ?? "security"}
                                        onChange={(e) =>
                                          updateCondition(index, ci, {
                                            category: e.target
                                              .value as EventLogCategory,
                                          })
                                        }
                                        className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm"
                                      >
                                        {eventCategoryOptions.map((o) => (
                                          <option key={o.value} value={o.value}>
                                            {o.label}
                                          </option>
                                        ))}
                                      </select>
                                    </div>
                                    <div>
                                      <label className="text-xs font-medium text-muted-foreground">
                                        {i18n.t(
                                          "policies:configurationPolicies.featureTabs.alertRuleTab.minimumLevel",
                                        )}
                                      </label>
                                      <select
                                        value={condition.level ?? "error"}
                                        onChange={(e) =>
                                          updateCondition(index, ci, {
                                            level: e.target
                                              .value as EventLogLevel,
                                          })
                                        }
                                        className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm"
                                      >
                                        {eventLevelOptions.map((o) => (
                                          <option key={o.value} value={o.value}>
                                            {o.label}
                                          </option>
                                        ))}
                                      </select>
                                      <p className="mt-1 text-[11px] text-muted-foreground">
                                        {i18n.t(
                                          "policies:configurationPolicies.featureTabs.alertRuleTab.matchesThisLevelAndAbove",
                                        )}
                                      </p>
                                    </div>
                                    <div>
                                      <label className="text-xs font-medium text-muted-foreground">
                                        {i18n.t(
                                          "policies:configurationPolicies.featureTabs.alertRuleTab.countThreshold",
                                        )}
                                      </label>
                                      <input
                                        type="number"
                                        min={1}
                                        max={EVENT_LOG_COUNT_MAX}
                                        value={condition.countThreshold ?? 1}
                                        onChange={(e) =>
                                          updateCondition(index, ci, {
                                            countThreshold: Math.min(
                                              EVENT_LOG_COUNT_MAX,
                                              Math.max(
                                                1,
                                                Number(e.target.value) || 1,
                                              ),
                                            ),
                                          })
                                        }
                                        className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm"
                                      />
                                      <p className="mt-1 text-[11px] text-muted-foreground">
                                        {i18n.t(
                                          "policies:configurationPolicies.featureTabs.alertRuleTab.alertWhenThisManyEventsOccur",
                                        )}
                                      </p>
                                    </div>
                                    <div>
                                      <label className="text-xs font-medium text-muted-foreground">
                                        {i18n.t(
                                          "policies:configurationPolicies.featureTabs.alertRuleTab.windowMinutes",
                                        )}
                                      </label>
                                      <input
                                        type="number"
                                        min={1}
                                        max={EVENT_LOG_WINDOW_MAX_MINUTES}
                                        value={condition.windowMinutes ?? 15}
                                        onChange={(e) =>
                                          updateCondition(index, ci, {
                                            windowMinutes: Math.min(
                                              EVENT_LOG_WINDOW_MAX_MINUTES,
                                              Math.max(
                                                1,
                                                Number(e.target.value) || 15,
                                              ),
                                            ),
                                          })
                                        }
                                        className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm"
                                      />
                                    </div>
                                    <div className="sm:col-span-2">
                                      <label className="text-xs font-medium text-muted-foreground">
                                        {i18n.t(
                                          "policies:configurationPolicies.featureTabs.alertRuleTab.sourcePatternOptional",
                                        )}
                                      </label>
                                      <input
                                        value={condition.sourcePattern ?? ""}
                                        onChange={(e) =>
                                          updateCondition(index, ci, {
                                            sourcePattern:
                                              e.target.value || undefined,
                                          })
                                        }
                                        maxLength={500}
                                        placeholder={i18n.t(
                                          "policies:configurationPolicies.featureTabs.alertRuleTab.eGEventLogOrSshd",
                                        )}
                                        className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm"
                                      />
                                      <p className="mt-1 text-[11px] text-muted-foreground">
                                        {i18n.t(
                                          "policies:configurationPolicies.featureTabs.alertRuleTab.textContainedInTheEventSourceCaseInsensitive",
                                        )}
                                      </p>
                                    </div>
                                    <div className="sm:col-span-2">
                                      <label className="text-xs font-medium text-muted-foreground">
                                        {i18n.t(
                                          "policies:configurationPolicies.featureTabs.alertRuleTab.messagePatternOptional",
                                        )}
                                      </label>
                                      <input
                                        value={condition.messagePattern ?? ""}
                                        onChange={(e) =>
                                          updateCondition(index, ci, {
                                            messagePattern:
                                              e.target.value || undefined,
                                          })
                                        }
                                        maxLength={500}
                                        placeholder={i18n.t(
                                          "policies:configurationPolicies.featureTabs.alertRuleTab.eGFailedLogin",
                                        )}
                                        className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm"
                                      />
                                      <p className="mt-1 text-[11px] text-muted-foreground">
                                        {i18n.t(
                                          "policies:configurationPolicies.featureTabs.alertRuleTab.textContainedInTheEventMessageCaseInsensitive",
                                        )}
                                      </p>
                                    </div>
                                  </>
                                )}
                              </div>
                              <button
                                type="button"
                                onClick={() => removeCondition(index, ci)}
                                disabled={item.conditions.length <= 1}
                                className="mt-4 flex h-8 w-8 items-center justify-center rounded-md text-destructive hover:bg-muted disabled:opacity-50"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Advanced settings */}
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <label className="text-xs font-medium text-muted-foreground">
                        {i18n.t(
                          "policies:configurationPolicies.featureTabs.alertRuleTab.cooldownMinutes",
                        )}
                      </label>
                      <input
                        type="number"
                        min={1}
                        max={1440}
                        value={item.cooldownMinutes}
                        onChange={(e) =>
                          updateItem(index, {
                            cooldownMinutes: Number(e.target.value) || 15,
                          })
                        }
                        className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                      />
                      <p className="mt-1 text-xs text-muted-foreground">
                        {i18n.t(
                          "policies:configurationPolicies.featureTabs.alertRuleTab.minTimeBetweenAlerts",
                        )}
                      </p>
                    </div>
                    <div>
                      <label className="text-xs font-medium text-muted-foreground">
                        {i18n.t(
                          "policies:configurationPolicies.featureTabs.alertRuleTab.autoResolve",
                        )}
                      </label>
                      <label className="mt-2 flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={item.autoResolve}
                          onChange={(e) =>
                            updateItem(index, { autoResolve: e.target.checked })
                          }
                          className="h-4 w-4 rounded border-muted"
                        />
                        <span className="text-sm">
                          {i18n.t(
                            "policies:configurationPolicies.featureTabs.alertRuleTab.resolveWhenConditionClears",
                          )}
                        </span>
                      </label>
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </FeatureTabShell>
  );
}
