import { useState, useEffect, useRef } from 'react';
import { Bell, Plus, Trash2, ChevronDown, ChevronRight } from 'lucide-react';
import type { FeatureTabProps } from './types';
import { FEATURE_META } from './types';
import { useFeatureLink } from './useFeatureLink';
import FeatureTabShell from './FeatureTabShell';

type ConditionType = 'metric' | 'status' | 'custom';
type AlertSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

type Condition = {
  type: ConditionType;
  metric?: string;
  operator?: string;
  value?: number;
  duration?: number;
  field?: string;
  customCondition?: string;
};

type AlertItem = {
  name: string;
  severity: AlertSeverity;
  conditions: Condition[];
  cooldownMinutes: number;
  autoResolve: boolean;
};

const defaultItem: AlertItem = {
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
  { value: 'metric', label: 'Metric' },
  { value: 'status', label: 'Status' },
  { value: 'custom', label: 'Custom' },
];

function loadItems(existingLink: FeatureTabProps['existingLink']): AlertItem[] {
  const raw = existingLink?.inlineSettings as Record<string, unknown> | null | undefined;
  if (!raw) return [];
  if (Array.isArray((raw as any).items)) {
    return (raw as any).items as AlertItem[];
  }
  // Legacy single-item format — wrap it
  if ((raw as any).severity) {
    const legacy = raw as unknown as Omit<AlertItem, 'name'>;
    return [{ ...legacy, name: 'Alert Rule 1' }];
  }
  return [];
}

function severityPill(severity: AlertSeverity) {
  const opt = severityOptions.find((o) => o.value === severity);
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium">
      <span className={`h-2 w-2 rounded-full ${opt?.color ?? 'bg-gray-400'}`} />
      {opt?.label ?? severity}
    </span>
  );
}

export default function AlertRuleTab({ policyId, existingLink, onLinkChanged, linkedPolicyId, parentLink }: FeatureTabProps) {
  const { save, remove, saving, error, clearError } = useFeatureLink(policyId);
  const isInherited = !!parentLink && !existingLink;
  const effectiveLink = existingLink ?? parentLink;
  const [items, setItems] = useState<AlertItem[]>(() => loadItems(effectiveLink));
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

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
    setItems((prev) => prev.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  };

  const updateCondition = (itemIndex: number, condIndex: number, patch: Partial<Condition>) => {
    setItems((prev) =>
      prev.map((item, i) => {
        if (i !== itemIndex) return item;
        const conditions = item.conditions.map((c, ci) => (ci === condIndex ? { ...c, ...patch } : c));
        return { ...item, conditions };
      })
    );
  };

  const addCondition = (itemIndex: number) => {
    setItems((prev) =>
      prev.map((item, i) => {
        if (i !== itemIndex) return item;
        return { ...item, conditions: [...item.conditions, { type: 'metric' as ConditionType, metric: 'cpu', operator: 'gt', value: 80 }] };
      })
    );
  };

  const removeCondition = (itemIndex: number, condIndex: number) => {
    setItems((prev) =>
      prev.map((item, i) => {
        if (i !== itemIndex) return item;
        return { ...item, conditions: item.conditions.filter((_, ci) => ci !== condIndex) };
      })
    );
  };

  const addItem = () => {
    const newItem: AlertItem = { ...defaultItem, name: `Alert Rule ${items.length + 1}`, conditions: [{ ...defaultItem.conditions[0] }] };
    setItems((prev) => [...prev, newItem]);
    setExpandedIndex(items.length);
  };

  const deleteItem = (index: number) => {
    setItems((prev) => prev.filter((_, i) => i !== index));
    if (expandedIndex === index) setExpandedIndex(null);
    else if (expandedIndex !== null && expandedIndex > index) setExpandedIndex(expandedIndex - 1);
  };

  const handleSave = async () => {
    clearError();
    const result = await save(existingLink?.id ?? null, {
      featureType: 'alert_rule',
      featurePolicyId: linkedPolicyId,
      inlineSettings: { items },
    });
    if (result) onLinkChanged(result, 'alert_rule');
  };

  const handleRemove = async () => {
    if (!existingLink) return;
    const ok = await remove(existingLink.id);
    if (ok) onLinkChanged(null, 'alert_rule');
  };

  const handleOverride = async () => {
    clearError();
    const result = await save(null, {
      featureType: 'alert_rule',
      featurePolicyId: linkedPolicyId,
      inlineSettings: { items },
    });
    if (result) onLinkChanged(result, 'alert_rule');
  };

  const handleRevert = async () => {
    if (!existingLink) return;
    const ok = await remove(existingLink.id);
    if (ok) onLinkChanged(null, 'alert_rule');
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
      onRevert={!isInherited && !!linkedPolicyId && !!existingLink ? handleRevert : undefined}
    >
      {/* Header with count + Add button */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">Alert Rules</h3>
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
          <Plus className="h-4 w-4" /> Add Alert Rule
        </button>
      </div>

      {/* Empty state */}
      {items.length === 0 && (
        <div className="mt-4 rounded-md border border-dashed p-8 text-center">
          <Bell className="mx-auto h-8 w-8 text-muted-foreground/50" />
          <p className="mt-2 text-sm text-muted-foreground">No alert rules configured yet.</p>
          <button
            type="button"
            onClick={addItem}
            className="mt-3 inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            <Plus className="h-4 w-4" /> Add Alert Rule
          </button>
        </div>
      )}

      {/* Item cards */}
      <div className="mt-3 space-y-2">
        {items.map((item, index) => {
          const isExpanded = expandedIndex === index;
          return (
            <div key={index} className="rounded-md border bg-muted/10">
              {/* Collapsed header */}
              <button
                type="button"
                onClick={() => setExpandedIndex(isExpanded ? null : index)}
                className="flex w-full items-center justify-between px-4 py-3 text-left"
              >
                <div className="flex items-center gap-3">
                  {isExpanded ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
                  <span className="text-sm font-medium">{item.name || 'Untitled Rule'}</span>
                  {severityPill(item.severity)}
                  <span className="text-xs text-muted-foreground">
                    {item.conditions.length} condition{item.conditions.length !== 1 ? 's' : ''}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); deleteItem(index); }}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-destructive hover:bg-destructive/10"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </button>

              {/* Expanded form */}
              {isExpanded && (
                <div className="border-t px-4 pb-4 pt-3 space-y-4">
                  {/* Name */}
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">Rule Name</label>
                    <input
                      ref={nameInputRef}
                      value={item.name}
                      onChange={(e) => updateItem(index, { name: e.target.value })}
                      placeholder="e.g. High CPU Alert"
                      className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>

                  {/* Severity */}
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">Severity</label>
                    <div className="mt-1.5 flex flex-wrap gap-2">
                      {severityOptions.map((opt) => (
                        <button
                          key={opt.value}
                          type="button"
                          onClick={() => updateItem(index, { severity: opt.value })}
                          className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium transition ${
                            item.severity === opt.value
                              ? 'border-primary bg-primary/10 text-foreground'
                              : 'border-muted bg-background text-muted-foreground hover:bg-muted'
                          }`}
                        >
                          <span className={`h-2.5 w-2.5 rounded-full ${opt.color}`} />
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Conditions */}
                  <div>
                    <div className="flex items-center justify-between">
                      <label className="text-xs font-medium text-muted-foreground">Conditions</label>
                      <button
                        type="button"
                        onClick={() => addCondition(index)}
                        className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted"
                      >
                        <Plus className="h-3 w-3" /> Add
                      </button>
                    </div>
                    <div className="mt-2 space-y-2">
                      {item.conditions.map((condition, ci) => (
                        <div key={ci} className="rounded-md border bg-muted/20 p-3">
                          <div className="flex items-start gap-2">
                            <div className="flex-1 grid gap-2 sm:grid-cols-2 md:grid-cols-4">
                              <div>
                                <label className="text-xs font-medium text-muted-foreground">Type</label>
                                <select
                                  value={condition.type}
                                  onChange={(e) => updateCondition(index, ci, { type: e.target.value as ConditionType })}
                                  className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm"
                                >
                                  {conditionTypeOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                                </select>
                              </div>

                              {condition.type === 'metric' && (
                                <>
                                  <div>
                                    <label className="text-xs font-medium text-muted-foreground">Metric</label>
                                    <select
                                      value={condition.metric ?? 'cpu'}
                                      onChange={(e) => updateCondition(index, ci, { metric: e.target.value })}
                                      className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm"
                                    >
                                      {metricOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                                    </select>
                                  </div>
                                  <div>
                                    <label className="text-xs font-medium text-muted-foreground">Operator</label>
                                    <select
                                      value={condition.operator ?? 'gt'}
                                      onChange={(e) => updateCondition(index, ci, { operator: e.target.value })}
                                      className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm"
                                    >
                                      {operatorOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                                    </select>
                                  </div>
                                  <div>
                                    <label className="text-xs font-medium text-muted-foreground">Value (%)</label>
                                    <input
                                      type="number"
                                      min={0}
                                      max={100}
                                      value={condition.value ?? 80}
                                      onChange={(e) => updateCondition(index, ci, { value: Number(e.target.value) })}
                                      className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm"
                                    />
                                  </div>
                                </>
                              )}

                              {condition.type === 'status' && (
                                <div className="sm:col-span-3">
                                  <label className="text-xs font-medium text-muted-foreground">Offline Duration (min)</label>
                                  <input
                                    type="number"
                                    min={1}
                                    value={condition.duration ?? 5}
                                    onChange={(e) => updateCondition(index, ci, { duration: Number(e.target.value) })}
                                    className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm"
                                  />
                                </div>
                              )}

                              {condition.type === 'custom' && (
                                <>
                                  <div>
                                    <label className="text-xs font-medium text-muted-foreground">Field Name</label>
                                    <input
                                      value={condition.field ?? ''}
                                      onChange={(e) => updateCondition(index, ci, { field: e.target.value })}
                                      placeholder="custom_field"
                                      className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm"
                                    />
                                  </div>
                                  <div className="sm:col-span-2">
                                    <label className="text-xs font-medium text-muted-foreground">Condition</label>
                                    <input
                                      value={condition.customCondition ?? ''}
                                      onChange={(e) => updateCondition(index, ci, { customCondition: e.target.value })}
                                      placeholder="value > 100"
                                      className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm"
                                    />
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
                      ))}
                    </div>
                  </div>

                  {/* Advanced settings */}
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <label className="text-xs font-medium text-muted-foreground">Cooldown (minutes)</label>
                      <input
                        type="number"
                        min={1}
                        max={1440}
                        value={item.cooldownMinutes}
                        onChange={(e) => updateItem(index, { cooldownMinutes: Number(e.target.value) || 15 })}
                        className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                      />
                      <p className="mt-1 text-xs text-muted-foreground">Min time between alerts</p>
                    </div>
                    <div>
                      <label className="text-xs font-medium text-muted-foreground">Auto-Resolve</label>
                      <label className="mt-2 flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={item.autoResolve}
                          onChange={(e) => updateItem(index, { autoResolve: e.target.checked })}
                          className="h-4 w-4 rounded border-muted"
                        />
                        <span className="text-sm">Resolve when condition clears</span>
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
