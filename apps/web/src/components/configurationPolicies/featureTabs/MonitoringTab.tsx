import { useState, useEffect, useRef, useCallback, type ReactNode } from 'react';
import { Activity, Plus, Trash2, Server, Cpu, FileWarning, Bell, ChevronDown, ChevronRight, Settings2 } from 'lucide-react';
import type { FeatureTabProps } from './types';
import { FEATURE_META } from './types';
import { useFeatureLink } from './useFeatureLink';
import FeatureTabShell from './FeatureTabShell';
import { fetchWithAuth } from '../../../stores/auth';

// ============================================
// Types
// ============================================

type WatchType = 'service' | 'process';
type AlertSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

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

type EventLogCategory = 'security' | 'hardware' | 'application' | 'system';
type EventLogLevel = 'warning' | 'error' | 'critical';

type EventLogAlertEntry = {
  name: string;
  category: EventLogCategory;
  level: EventLogLevel;
  sourcePattern?: string;
  messagePattern?: string;
  countThreshold: number;
  windowMinutes: number;
  severity: AlertSeverity;
  enabled: boolean;
};

type ConditionType = 'metric' | 'status' | 'custom' | 'bandwidth_high' | 'disk_io_high' | 'network_errors' | 'patch_compliance' | 'cert_expiry';

type Condition = {
  type: ConditionType;
  metric?: string;
  operator?: string;
  value?: number;
  duration?: number;
  field?: string;
  customCondition?: string;
  // bandwidth_high / network_errors
  networkDirection?: 'in' | 'out' | 'total';
  // disk_io_high
  diskDirection?: 'read' | 'write' | 'total';
  durationMinutes?: number;
  // network_errors
  interfaceName?: string;
  errorType?: 'in' | 'out' | 'total';
  windowMinutes?: number;
  // cert_expiry
  withinDays?: number;
};

type AlertRuleItem = {
  name: string;
  severity: AlertSeverity;
  conditions: Condition[];
  cooldownMinutes: number;
  autoResolve: boolean;
};

type MonitoringSettings = {
  checkIntervalSeconds: number;
  watches: WatchEntry[];
  eventLogAlerts: EventLogAlertEntry[];
  alertRules: AlertRuleItem[];
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
  eventLogAlerts: [],
  alertRules: [],
};

const defaultWatch: WatchEntry = {
  watchType: 'service',
  name: '',
  enabled: true,
  alertOnStop: true,
  alertAfterConsecutiveFailures: 2,
  alertSeverity: 'high',
  thresholdDurationSeconds: 300,
  autoRestart: false,
  maxRestartAttempts: 3,
  restartCooldownSeconds: 300,
};

const defaultEventLogAlert: EventLogAlertEntry = {
  name: '',
  category: 'security',
  level: 'error',
  countThreshold: 1,
  windowMinutes: 15,
  severity: 'high',
  enabled: true,
};

const defaultAlertRuleItem: AlertRuleItem = {
  name: '',
  severity: 'medium',
  conditions: [{ type: 'metric', metric: 'cpu', operator: 'gt', value: 80 }],
  cooldownMinutes: 15,
  autoResolve: false,
};

const severityOptions: { value: AlertSeverity; label: string; color: string }[] = [
  { value: 'critical', label: 'Critical', color: 'bg-red-500' },
  { value: 'high', label: 'High', color: 'bg-orange-500' },
  { value: 'medium', label: 'Medium', color: 'bg-yellow-500' },
  { value: 'low', label: 'Low', color: 'bg-blue-500' },
  { value: 'info', label: 'Info', color: 'bg-gray-500' },
];

const categoryOptions: { value: EventLogCategory; label: string }[] = [
  { value: 'security', label: 'Security' },
  { value: 'hardware', label: 'Hardware' },
  { value: 'application', label: 'Application' },
  { value: 'system', label: 'System' },
];

const levelOptions: { value: EventLogLevel; label: string }[] = [
  { value: 'warning', label: 'Warning' },
  { value: 'error', label: 'Error' },
  { value: 'critical', label: 'Critical' },
];

const metricOptions = [
  { value: 'cpu', label: 'CPU Usage' },
  { value: 'ram', label: 'Memory Usage' },
  { value: 'disk', label: 'Disk Usage' },
  { value: 'network', label: 'Network Usage' },
];

const operatorOptions = [
  { value: 'gt', label: '> (greater than)' },
  { value: 'lt', label: '< (less than)' },
  { value: 'gte', label: '>= (greater or equal)' },
  { value: 'lte', label: '<= (less or equal)' },
  { value: 'eq', label: '= (equal)' },
  { value: 'neq', label: '!= (not equal)' },
];

const conditionTypeOptions = [
  { value: 'metric', label: 'Metric Threshold' },
  { value: 'status', label: 'Offline Status' },
  { value: 'bandwidth_high', label: 'Bandwidth High' },
  { value: 'disk_io_high', label: 'Disk I/O High' },
  { value: 'network_errors', label: 'Network Errors' },
  { value: 'patch_compliance', label: 'Patch Compliance' },
  { value: 'cert_expiry', label: 'Certificate Expiry' },
  { value: 'custom', label: 'Custom' },
];

// ============================================
// Shared UI Components
// ============================================

function SeverityPill({ severity }: { severity: AlertSeverity }) {
  const opt = severityOptions.find((o) => o.value === severity);
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium">
      <span className={`h-2 w-2 rounded-full ${opt?.color ?? 'bg-gray-400'}`} />
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
  return (
    <div className="flex flex-wrap gap-2">
      {severityOptions.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium transition ${
            value === opt.value
              ? 'border-primary bg-primary/10 text-foreground'
              : 'border-muted bg-background text-muted-foreground hover:bg-muted'
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

  return (
    <div className="rounded-lg border bg-card overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(!open)}
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
      </button>

      {open && (
        <div className="border-t px-4 py-3">
          {children}
        </div>
      )}
    </div>
  );
}

function EmptyState({ icon, message, hint }: { icon: ReactNode; message: string; hint: string }) {
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

export default function MonitoringTab({ policyId, existingLink, onLinkChanged, linkedPolicyId, parentLink }: FeatureTabProps) {
  const { save, remove, saving, error, clearError } = useFeatureLink(policyId);
  const isInherited = !!parentLink && !existingLink;
  const effectiveLink = existingLink ?? parentLink;

  const [settings, setSettings] = useState<MonitoringSettings>(() => {
    const stored = effectiveLink?.inlineSettings as Partial<MonitoringSettings> | undefined;
    return {
      ...defaults,
      ...stored,
      watches: stored?.watches?.map((w) => ({ ...defaultWatch, ...w })) ?? [],
      eventLogAlerts: stored?.eventLogAlerts?.map((a) => ({ ...defaultEventLogAlert, ...a })) ?? [],
      alertRules: stored?.alertRules?.map((r) => ({ ...defaultAlertRuleItem, ...r })) ?? [],
    };
  });

  // Expanded item tracking: "watches:0", "eventlog:1", "alertrule:2"
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  // Known services for autocomplete
  const [knownServices, setKnownServices] = useState<KnownService[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetchWithAuth('/monitoring/known-services?limit=500')
      .then(async (res) => {
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (!cancelled && Array.isArray(data.data)) {
          setKnownServices(data.data);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const link = existingLink ?? parentLink;
    if (link?.inlineSettings) {
      const stored = link.inlineSettings as Partial<MonitoringSettings>;
      setSettings((prev) => ({
        ...prev,
        ...stored,
        watches: stored?.watches?.map((w) => ({ ...defaultWatch, ...w })) ?? prev.watches,
        eventLogAlerts: stored?.eventLogAlerts?.map((a) => ({ ...defaultEventLogAlert, ...a })) ?? prev.eventLogAlerts,
        alertRules: stored?.alertRules?.map((r) => ({ ...defaultAlertRuleItem, ...r })) ?? prev.alertRules,
      }));
    }
  }, [existingLink, parentLink]);

  // Focus name input when an item expands
  useEffect(() => {
    if (expandedKey !== null) {
      const t = setTimeout(() => nameInputRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [expandedKey]);

  const toggleExpand = (key: string) => setExpandedKey((prev) => (prev === key ? null : key));

  // ---- Watch CRUD ----
  const updateWatch = (index: number, patch: Partial<WatchEntry>) => {
    setSettings((prev) => ({
      ...prev,
      watches: prev.watches.map((w, i) => (i === index ? { ...w, ...patch } : w)),
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

  // ---- Event Log Alert CRUD ----
  const updateEventLogAlert = (index: number, patch: Partial<EventLogAlertEntry>) => {
    setSettings((prev) => ({
      ...prev,
      eventLogAlerts: prev.eventLogAlerts.map((a, i) => (i === index ? { ...a, ...patch } : a)),
    }));
  };

  const addEventLogAlert = () => {
    setSettings((prev) => ({
      ...prev,
      eventLogAlerts: [...prev.eventLogAlerts, { ...defaultEventLogAlert }],
    }));
    setExpandedKey(`eventlog:${settings.eventLogAlerts.length}`);
  };

  const removeEventLogAlert = (index: number) => {
    setSettings((prev) => ({
      ...prev,
      eventLogAlerts: prev.eventLogAlerts.filter((_, i) => i !== index),
    }));
    if (expandedKey === `eventlog:${index}`) setExpandedKey(null);
  };

  // ---- Alert Rule CRUD ----
  const addAlertRule = () => {
    const newRule: AlertRuleItem = { ...defaultAlertRuleItem, name: `Alert Rule ${settings.alertRules.length + 1}`, conditions: [{ ...defaultAlertRuleItem.conditions[0] }] };
    setSettings((prev) => ({ ...prev, alertRules: [...prev.alertRules, newRule] }));
    setExpandedKey(`alertrule:${settings.alertRules.length}`);
  };

  const deleteAlertRule = (index: number) => {
    setSettings((prev) => ({ ...prev, alertRules: prev.alertRules.filter((_, i) => i !== index) }));
    if (expandedKey === `alertrule:${index}`) setExpandedKey(null);
  };

  const updateAlertRule = (index: number, patch: Partial<AlertRuleItem>) => {
    setSettings((prev) => ({
      ...prev,
      alertRules: prev.alertRules.map((r, i) => (i === index ? { ...r, ...patch } : r)),
    }));
  };

  const updateAlertCondition = (ruleIndex: number, condIndex: number, patch: Partial<Condition>) => {
    setSettings((prev) => ({
      ...prev,
      alertRules: prev.alertRules.map((r, i) => {
        if (i !== ruleIndex) return r;
        return { ...r, conditions: r.conditions.map((c, ci) => (ci === condIndex ? { ...c, ...patch } : c)) };
      }),
    }));
  };

  const addAlertCondition = (ruleIndex: number) => {
    setSettings((prev) => ({
      ...prev,
      alertRules: prev.alertRules.map((r, i) => {
        if (i !== ruleIndex) return r;
        return { ...r, conditions: [...r.conditions, { type: 'metric' as ConditionType, metric: 'cpu', operator: 'gt', value: 80 }] };
      }),
    }));
  };

  const removeAlertCondition = (ruleIndex: number, condIndex: number) => {
    setSettings((prev) => ({
      ...prev,
      alertRules: prev.alertRules.map((r, i) => {
        if (i !== ruleIndex) return r;
        return { ...r, conditions: r.conditions.filter((_, ci) => ci !== condIndex) };
      }),
    }));
  };

  // ---- Save / Remove / Override / Revert ----
  const handleSave = async () => {
    clearError();
    const result = await save(existingLink?.id ?? null, {
      featureType: 'monitoring',
      featurePolicyId: linkedPolicyId,
      inlineSettings: settings,
    });
    if (result) onLinkChanged(result, 'monitoring');
  };

  const handleRemove = async () => {
    if (!existingLink) return;
    const ok = await remove(existingLink.id);
    if (ok) onLinkChanged(null, 'monitoring');
  };

  const handleOverride = async () => {
    clearError();
    const result = await save(null, {
      featureType: 'monitoring',
      featurePolicyId: linkedPolicyId,
      inlineSettings: settings,
    });
    if (result) onLinkChanged(result, 'monitoring');
  };

  const handleRevert = async () => {
    if (!existingLink) return;
    const ok = await remove(existingLink.id);
    if (ok) onLinkChanged(null, 'monitoring');
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
      onRevert={!isInherited && !!linkedPolicyId && !!existingLink ? handleRevert : undefined}
    >
      {/* ── General Settings ── */}
      <div className="rounded-lg border bg-muted/20 p-4">
        <div className="flex items-center gap-2 mb-3">
          <Settings2 className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">General</h3>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="text-xs font-medium text-muted-foreground">Check Interval</label>
            <p className="text-[10px] text-muted-foreground/70">How often the agent checks watched services and processes</p>
            <div className="mt-1.5 flex items-center gap-2">
              <input
                type="number"
                min={10}
                max={3600}
                value={settings.checkIntervalSeconds}
                onChange={(e) =>
                  setSettings((prev) => ({
                    ...prev,
                    checkIntervalSeconds: Math.max(10, Math.min(3600, Number(e.target.value) || 60)),
                  }))
                }
                className="h-9 w-24 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
              <span className="text-sm text-muted-foreground">seconds</span>
            </div>
          </div>
        </div>
      </div>

      {/* ── Service & Process Watches ── */}
      <div className="mt-4">
        <MonitoringSection
          icon={<Server className="h-4 w-4 text-muted-foreground" />}
          title="Service & Process Watches"
          count={settings.watches.length}
          description="Monitor running services and processes, alert on stop, auto-restart"
          onAdd={() => addWatch()}
          addLabel="Add Watch"
        >
          {settings.watches.length === 0 ? (
            <EmptyState
              icon={<Activity className="h-5 w-5 text-muted-foreground/50" />}
              message="No watches configured yet."
              hint="Add a service or process to start monitoring."
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
                  nameInputRef={expandedKey === `watches:${idx}` ? nameInputRef : undefined}
                />
              ))}
            </div>
          )}
        </MonitoringSection>
      </div>

      {/* ── Event Log Alerts ── */}
      <div className="mt-4">
        <MonitoringSection
          icon={<FileWarning className="h-4 w-4 text-muted-foreground" />}
          title="Event Log Alerts"
          count={settings.eventLogAlerts.length}
          description="Alert on Windows Event Log, macOS unified log, or Linux journal events"
          onAdd={addEventLogAlert}
          addLabel="Add Alert"
        >
          {settings.eventLogAlerts.length === 0 ? (
            <EmptyState
              icon={<FileWarning className="h-5 w-5 text-muted-foreground/50" />}
              message="No event log alerts configured."
              hint="Add a rule to alert on log events matching specific patterns."
            />
          ) : (
            <div className="space-y-2">
              {settings.eventLogAlerts.map((alert, idx) => (
                <EventLogAlertCard
                  key={idx}
                  alert={alert}
                  expanded={expandedKey === `eventlog:${idx}`}
                  onToggle={() => toggleExpand(`eventlog:${idx}`)}
                  onChange={(patch) => updateEventLogAlert(idx, patch)}
                  onRemove={() => removeEventLogAlert(idx)}
                  nameInputRef={expandedKey === `eventlog:${idx}` ? nameInputRef : undefined}
                />
              ))}
            </div>
          )}
        </MonitoringSection>
      </div>

      {/* ── Metric & Status Alert Rules ── */}
      <div className="mt-4">
        <MonitoringSection
          icon={<Bell className="h-4 w-4 text-muted-foreground" />}
          title="Metric & Status Alert Rules"
          count={settings.alertRules.length}
          description="CPU/RAM/disk thresholds, offline detection, and custom conditions"
          onAdd={addAlertRule}
          addLabel="Add Rule"
        >
          {settings.alertRules.length === 0 ? (
            <EmptyState
              icon={<Bell className="h-5 w-5 text-muted-foreground/50" />}
              message="No alert rules configured yet."
              hint="Add metric thresholds, offline detection, or custom conditions."
            />
          ) : (
            <div className="space-y-2">
              {settings.alertRules.map((rule, idx) => (
                <AlertRuleCard
                  key={idx}
                  rule={rule}
                  expanded={expandedKey === `alertrule:${idx}`}
                  onToggle={() => toggleExpand(`alertrule:${idx}`)}
                  onUpdate={(patch) => updateAlertRule(idx, patch)}
                  onDelete={() => deleteAlertRule(idx)}
                  onUpdateCondition={(ci, patch) => updateAlertCondition(idx, ci, patch)}
                  onAddCondition={() => addAlertCondition(idx)}
                  onRemoveCondition={(ci) => removeAlertCondition(idx, ci)}
                  nameInputRef={expandedKey === `alertrule:${idx}` ? nameInputRef : undefined}
                />
              ))}
            </div>
          )}
        </MonitoringSection>
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
  const summaryParts: string[] = [];
  if (watch.alertOnStop) summaryParts.push('alert on stop');
  if (watch.autoRestart) summaryParts.push('auto-restart');
  summaryParts.push(`${watch.alertAfterConsecutiveFailures} failures`);

  return (
    <div className="rounded-md border bg-background">
      {/* Header */}
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
      >
        {expanded ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted/60">
          {watch.watchType === 'service' ? <Server className="h-3.5 w-3.5 text-muted-foreground" /> : <Cpu className="h-3.5 w-3.5 text-muted-foreground" />}
        </div>
        <span className="text-sm font-medium truncate">
          {watch.name || <span className="italic text-muted-foreground">Unnamed watch</span>}
        </span>
        <span className="shrink-0 inline-flex items-center rounded-full border bg-muted/40 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
          {watch.watchType}
        </span>
        <SeverityPill severity={watch.alertSeverity} />
        <span className="hidden sm:inline text-xs text-muted-foreground truncate">{summaryParts.join(', ')}</span>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onChange({ enabled: !watch.enabled }); }}
            className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition ${watch.enabled ? 'bg-emerald-500/80' : 'bg-muted'}`}
          >
            <span className={`inline-block h-4 w-4 rounded-full bg-white transition ${watch.enabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onRemove(); }}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-destructive hover:bg-destructive/10"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </button>

      {/* Expanded form */}
      {expanded && (
        <div className="border-t px-4 py-3 space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground">Type</label>
              <select
                value={watch.watchType}
                onChange={(e) => onChange({ watchType: e.target.value as WatchType })}
                className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="service">Service</option>
                <option value="process">Process</option>
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Name</label>
              <ServiceNameAutocomplete
                value={watch.name}
                onChange={(name) => onChange({ name })}
                placeholder={watch.watchType === 'service' ? 'e.g. nginx, sshd' : 'e.g. node, java'}
                knownServices={knownServices}
                inputRef={nameInputRef}
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Display Name</label>
              <input
                value={watch.displayName ?? ''}
                onChange={(e) => onChange({ displayName: e.target.value || undefined })}
                placeholder="Friendly label (optional)"
                className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          </div>

          {/* Severity */}
          <div>
            <label className="text-xs font-medium text-muted-foreground">Alert Severity</label>
            <div className="mt-1.5">
              <SeverityButtonGroup value={watch.alertSeverity} onChange={(v) => onChange({ alertSeverity: v })} />
            </div>
          </div>

          {/* Alert settings */}
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="flex items-center gap-2">
              <input type="checkbox" checked={watch.alertOnStop} onChange={(e) => onChange({ alertOnStop: e.target.checked })} className="h-4 w-4 rounded border" />
              <label className="text-xs font-medium">Alert on stop</label>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Consecutive failures</label>
              <input
                type="number" min={1} max={100} value={watch.alertAfterConsecutiveFailures}
                onChange={(e) => onChange({ alertAfterConsecutiveFailures: Math.max(1, Math.min(100, Number(e.target.value) || 2)) })}
                className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          </div>

          {/* Process thresholds */}
          {watch.watchType === 'process' && (
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground">CPU threshold (%)</label>
                <input type="number" min={0} max={100} value={watch.cpuThresholdPercent ?? ''} onChange={(e) => onChange({ cpuThresholdPercent: e.target.value ? Number(e.target.value) : undefined })} placeholder="None" className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Memory threshold (MB)</label>
                <input type="number" min={0} value={watch.memoryThresholdMb ?? ''} onChange={(e) => onChange({ memoryThresholdMb: e.target.value ? Number(e.target.value) : undefined })} placeholder="None" className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Threshold duration (s)</label>
                <input type="number" min={0} max={86400} value={watch.thresholdDurationSeconds} onChange={(e) => onChange({ thresholdDurationSeconds: Math.max(0, Math.min(86400, Number(e.target.value) || 300)) })} className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
              </div>
            </div>
          )}

          {/* Auto-restart */}
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="flex items-center gap-2">
              <input type="checkbox" checked={watch.autoRestart} onChange={(e) => onChange({ autoRestart: e.target.checked })} className="h-4 w-4 rounded border" />
              <label className="text-xs font-medium">Auto-restart</label>
            </div>
            {watch.autoRestart && (
              <>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Max restart attempts</label>
                  <input type="number" min={0} max={50} value={watch.maxRestartAttempts} onChange={(e) => onChange({ maxRestartAttempts: Math.max(0, Math.min(50, Number(e.target.value) || 3)) })} className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Cooldown (seconds)</label>
                  <input type="number" min={30} max={86400} value={watch.restartCooldownSeconds} onChange={(e) => onChange({ restartCooldownSeconds: Math.max(30, Math.min(86400, Number(e.target.value) || 300)) })} className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
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
// Event Log Alert Card
// ============================================

function EventLogAlertCard({
  alert,
  expanded,
  onToggle,
  onChange,
  onRemove,
  nameInputRef,
}: {
  alert: EventLogAlertEntry;
  expanded: boolean;
  onToggle: () => void;
  onChange: (patch: Partial<EventLogAlertEntry>) => void;
  onRemove: () => void;
  nameInputRef?: React.RefObject<HTMLInputElement | null>;
}) {
  return (
    <div className="rounded-md border bg-background">
      {/* Header */}
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
      >
        {expanded ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted/60">
          <FileWarning className="h-3.5 w-3.5 text-muted-foreground" />
        </div>
        <span className="text-sm font-medium truncate">
          {alert.name || <span className="italic text-muted-foreground">Unnamed alert</span>}
        </span>
        <span className="shrink-0 inline-flex items-center rounded-full border bg-muted/40 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
          {alert.category}
        </span>
        <SeverityPill severity={alert.severity} />
        <span className="hidden sm:inline text-xs text-muted-foreground truncate">
          {alert.level}+ &ge; {alert.countThreshold} in {alert.windowMinutes}m
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onChange({ enabled: !alert.enabled }); }}
            className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition ${alert.enabled ? 'bg-emerald-500/80' : 'bg-muted'}`}
          >
            <span className={`inline-block h-4 w-4 rounded-full bg-white transition ${alert.enabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onRemove(); }}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-destructive hover:bg-destructive/10"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </button>

      {/* Expanded form */}
      {expanded && (
        <div className="border-t px-4 py-3 space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground">Rule Name</label>
              <input ref={nameInputRef} value={alert.name} onChange={(e) => onChange({ name: e.target.value })} placeholder="e.g. Security errors" className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Category</label>
              <select value={alert.category} onChange={(e) => onChange({ category: e.target.value as EventLogCategory })} className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring">
                {categoryOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Minimum Level</label>
              <select value={alert.level} onChange={(e) => onChange({ level: e.target.value as EventLogLevel })} className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring">
                {levelOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <p className="mt-1 text-[10px] text-muted-foreground">Matches this level and above</p>
            </div>
          </div>

          {/* Severity */}
          <div>
            <label className="text-xs font-medium text-muted-foreground">Alert Severity</label>
            <div className="mt-1.5">
              <SeverityButtonGroup value={alert.severity} onChange={(v) => onChange({ severity: v })} />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="text-xs font-medium text-muted-foreground">Source Pattern (optional)</label>
              <input value={alert.sourcePattern ?? ''} onChange={(e) => onChange({ sourcePattern: e.target.value || undefined })} placeholder="e.g. EventLog or sshd" className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
              <p className="mt-1 text-[10px] text-muted-foreground">Regex to match the event source</p>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Message Pattern (optional)</label>
              <input value={alert.messagePattern ?? ''} onChange={(e) => onChange({ messagePattern: e.target.value || undefined })} placeholder="e.g. failed login|authentication" className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
              <p className="mt-1 text-[10px] text-muted-foreground">Regex to match the event message</p>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="text-xs font-medium text-muted-foreground">Count Threshold</label>
              <input type="number" min={1} max={10000} value={alert.countThreshold} onChange={(e) => onChange({ countThreshold: Math.max(1, Math.min(10000, Number(e.target.value) || 1)) })} className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
              <p className="mt-1 text-[10px] text-muted-foreground">Alert when this many events occur</p>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Time Window (minutes)</label>
              <input type="number" min={1} max={1440} value={alert.windowMinutes} onChange={(e) => onChange({ windowMinutes: Math.max(1, Math.min(1440, Number(e.target.value) || 15)) })} className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================
// Alert Rule Card
// ============================================

function AlertRuleCard({
  rule,
  expanded,
  onToggle,
  onUpdate,
  onDelete,
  onUpdateCondition,
  onAddCondition,
  onRemoveCondition,
  nameInputRef,
}: {
  rule: AlertRuleItem;
  expanded: boolean;
  onToggle: () => void;
  onUpdate: (patch: Partial<AlertRuleItem>) => void;
  onDelete: () => void;
  onUpdateCondition: (ci: number, patch: Partial<Condition>) => void;
  onAddCondition: () => void;
  onRemoveCondition: (ci: number) => void;
  nameInputRef?: React.RefObject<HTMLInputElement | null>;
}) {
  return (
    <div className="rounded-md border bg-background">
      {/* Header */}
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
      >
        {expanded ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted/60">
          <Bell className="h-3.5 w-3.5 text-muted-foreground" />
        </div>
        <span className="text-sm font-medium truncate">
          {rule.name || <span className="italic text-muted-foreground">Untitled Rule</span>}
        </span>
        <SeverityPill severity={rule.severity} />
        <span className="text-xs text-muted-foreground">
          {rule.conditions.length} condition{rule.conditions.length !== 1 ? 's' : ''}
        </span>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          className="ml-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-destructive hover:bg-destructive/10"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </button>

      {/* Expanded form */}
      {expanded && (
        <div className="border-t px-4 pb-4 pt-3 space-y-4">
          {/* Name */}
          <div>
            <label className="text-xs font-medium text-muted-foreground">Rule Name</label>
            <input ref={nameInputRef} value={rule.name} onChange={(e) => onUpdate({ name: e.target.value })} placeholder="e.g. High CPU Alert" className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
          </div>

          {/* Severity */}
          <div>
            <label className="text-xs font-medium text-muted-foreground">Severity</label>
            <div className="mt-1.5">
              <SeverityButtonGroup value={rule.severity} onChange={(v) => onUpdate({ severity: v })} />
            </div>
          </div>

          {/* Conditions */}
          <div>
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-muted-foreground">Conditions</label>
              <button type="button" onClick={onAddCondition} className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted">
                <Plus className="h-3 w-3" /> Add
              </button>
            </div>
            <div className="mt-2 space-y-2">
              {rule.conditions.map((condition, ci) => (
                <div key={ci} className="rounded-md border bg-muted/20 p-3">
                  <div className="flex items-start gap-2">
                    <div className="flex-1 grid gap-2 sm:grid-cols-2 md:grid-cols-4">
                      <div>
                        <label className="text-xs font-medium text-muted-foreground">Type</label>
                        <select value={condition.type} onChange={(e) => onUpdateCondition(ci, { type: e.target.value as ConditionType })} className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm">
                          {conditionTypeOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                      </div>
                      {condition.type === 'metric' && (
                        <>
                          <div>
                            <label className="text-xs font-medium text-muted-foreground">Metric</label>
                            <select value={condition.metric ?? 'cpu'} onChange={(e) => onUpdateCondition(ci, { metric: e.target.value })} className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm">
                              {metricOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                            </select>
                          </div>
                          <div>
                            <label className="text-xs font-medium text-muted-foreground">Operator</label>
                            <select value={condition.operator ?? 'gt'} onChange={(e) => onUpdateCondition(ci, { operator: e.target.value })} className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm">
                              {operatorOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                            </select>
                          </div>
                          <div>
                            <label className="text-xs font-medium text-muted-foreground">Value (%)</label>
                            <input type="number" min={0} max={100} value={condition.value ?? 80} onChange={(e) => onUpdateCondition(ci, { value: Number(e.target.value) })} className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm" />
                          </div>
                        </>
                      )}
                      {condition.type === 'status' && (
                        <div className="sm:col-span-3">
                          <label className="text-xs font-medium text-muted-foreground">Offline Duration (min)</label>
                          <input type="number" min={1} value={condition.duration ?? 5} onChange={(e) => onUpdateCondition(ci, { duration: Number(e.target.value) })} className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm" />
                        </div>
                      )}
                      {condition.type === 'bandwidth_high' && (
                        <>
                          <div>
                            <label className="text-xs font-medium text-muted-foreground">Direction</label>
                            <select value={condition.networkDirection ?? 'total'} onChange={(e) => onUpdateCondition(ci, { networkDirection: e.target.value as Condition['networkDirection'] })} className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm">
                              <option value="in">Inbound</option>
                              <option value="out">Outbound</option>
                              <option value="total">Total</option>
                            </select>
                          </div>
                          <div>
                            <label className="text-xs font-medium text-muted-foreground">Operator</label>
                            <select value={condition.operator ?? 'gt'} onChange={(e) => onUpdateCondition(ci, { operator: e.target.value })} className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm">
                              {operatorOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                            </select>
                          </div>
                          <div>
                            <label className="text-xs font-medium text-muted-foreground">Threshold (Mbps)</label>
                            <input type="number" min={0} step={0.1} value={condition.value ?? 100} onChange={(e) => onUpdateCondition(ci, { value: Number(e.target.value) })} className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm" />
                          </div>
                          <div>
                            <label className="text-xs font-medium text-muted-foreground">Duration (min)</label>
                            <input type="number" min={1} value={condition.durationMinutes ?? 5} onChange={(e) => onUpdateCondition(ci, { durationMinutes: Number(e.target.value) })} className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm" />
                          </div>
                        </>
                      )}
                      {condition.type === 'disk_io_high' && (
                        <>
                          <div>
                            <label className="text-xs font-medium text-muted-foreground">Direction</label>
                            <select value={condition.diskDirection ?? 'total'} onChange={(e) => onUpdateCondition(ci, { diskDirection: e.target.value as Condition['diskDirection'] })} className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm">
                              <option value="read">Read</option>
                              <option value="write">Write</option>
                              <option value="total">Total</option>
                            </select>
                          </div>
                          <div>
                            <label className="text-xs font-medium text-muted-foreground">Operator</label>
                            <select value={condition.operator ?? 'gt'} onChange={(e) => onUpdateCondition(ci, { operator: e.target.value })} className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm">
                              {operatorOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                            </select>
                          </div>
                          <div>
                            <label className="text-xs font-medium text-muted-foreground">Threshold (MB/s)</label>
                            <input type="number" min={0} step={0.1} value={condition.value ?? 50} onChange={(e) => onUpdateCondition(ci, { value: Number(e.target.value) })} className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm" />
                          </div>
                          <div>
                            <label className="text-xs font-medium text-muted-foreground">Duration (min)</label>
                            <input type="number" min={1} value={condition.durationMinutes ?? 5} onChange={(e) => onUpdateCondition(ci, { durationMinutes: Number(e.target.value) })} className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm" />
                          </div>
                        </>
                      )}
                      {condition.type === 'network_errors' && (
                        <>
                          <div>
                            <label className="text-xs font-medium text-muted-foreground">Error Type</label>
                            <select value={condition.errorType ?? 'total'} onChange={(e) => onUpdateCondition(ci, { errorType: e.target.value as Condition['errorType'] })} className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm">
                              <option value="in">Inbound Errors</option>
                              <option value="out">Outbound Errors</option>
                              <option value="total">Total Errors</option>
                            </select>
                          </div>
                          <div>
                            <label className="text-xs font-medium text-muted-foreground">Operator</label>
                            <select value={condition.operator ?? 'gt'} onChange={(e) => onUpdateCondition(ci, { operator: e.target.value })} className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm">
                              {operatorOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                            </select>
                          </div>
                          <div>
                            <label className="text-xs font-medium text-muted-foreground">Threshold</label>
                            <input type="number" min={0} value={condition.value ?? 10} onChange={(e) => onUpdateCondition(ci, { value: Number(e.target.value) })} className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm" />
                          </div>
                          <div>
                            <label className="text-xs font-medium text-muted-foreground">Window (min)</label>
                            <input type="number" min={1} value={condition.windowMinutes ?? 5} onChange={(e) => onUpdateCondition(ci, { windowMinutes: Number(e.target.value) })} className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm" />
                          </div>
                        </>
                      )}
                      {condition.type === 'patch_compliance' && (
                        <>
                          <div>
                            <label className="text-xs font-medium text-muted-foreground">Operator</label>
                            <select value={condition.operator ?? 'lt'} onChange={(e) => onUpdateCondition(ci, { operator: e.target.value })} className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm">
                              {operatorOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                            </select>
                          </div>
                          <div className="sm:col-span-2">
                            <label className="text-xs font-medium text-muted-foreground">Compliance Score (%)</label>
                            <input type="number" min={0} max={100} value={condition.value ?? 80} onChange={(e) => onUpdateCondition(ci, { value: Number(e.target.value) })} className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm" />
                          </div>
                        </>
                      )}
                      {condition.type === 'cert_expiry' && (
                        <div className="sm:col-span-3">
                          <label className="text-xs font-medium text-muted-foreground">Expires Within (days)</label>
                          <input type="number" min={1} value={condition.withinDays ?? 30} onChange={(e) => onUpdateCondition(ci, { withinDays: Number(e.target.value) })} className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm" />
                        </div>
                      )}
                      {condition.type === 'custom' && (
                        <>
                          <div>
                            <label className="text-xs font-medium text-muted-foreground">Field Name</label>
                            <input value={condition.field ?? ''} onChange={(e) => onUpdateCondition(ci, { field: e.target.value })} placeholder="custom_field" className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm" />
                          </div>
                          <div className="sm:col-span-2">
                            <label className="text-xs font-medium text-muted-foreground">Condition</label>
                            <input value={condition.customCondition ?? ''} onChange={(e) => onUpdateCondition(ci, { customCondition: e.target.value })} placeholder="value > 100" className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm" />
                          </div>
                        </>
                      )}
                    </div>
                    <button type="button" onClick={() => onRemoveCondition(ci)} disabled={rule.conditions.length <= 1} className="mt-4 flex h-8 w-8 items-center justify-center rounded-md text-destructive hover:bg-muted disabled:opacity-50">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Advanced */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="text-xs font-medium text-muted-foreground">Cooldown (minutes)</label>
              <input type="number" min={1} max={1440} value={rule.cooldownMinutes} onChange={(e) => onUpdate({ cooldownMinutes: Number(e.target.value) || 15 })} className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
              <p className="mt-1 text-xs text-muted-foreground">Min time between alerts</p>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Auto-Resolve</label>
              <label className="mt-2 flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={rule.autoResolve} onChange={(e) => onUpdate({ autoResolve: e.target.checked })} className="h-4 w-4 rounded border-muted" />
                <span className="text-sm">Resolve when condition clears</span>
              </label>
            </div>
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
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const filtered = inputValue
    ? knownServices.filter((s) => s.name.toLowerCase().includes(inputValue.toLowerCase())).slice(0, 15)
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
        className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
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
                {svc.source === 'check_results' ? 'monitored' : 'inventory'}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
