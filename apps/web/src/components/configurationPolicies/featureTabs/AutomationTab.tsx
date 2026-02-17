import { useState, useEffect, useRef } from 'react';
import { Zap, Plus, Trash2, ChevronDown, ChevronRight, Clock, Radio, Hand } from 'lucide-react';
import type { FeatureTabProps } from './types';
import { FEATURE_META } from './types';
import { useFeatureLink } from './useFeatureLink';
import FeatureTabShell from './FeatureTabShell';

type TriggerType = 'schedule' | 'event' | 'manual';
type ActionType = 'run_script' | 'send_notification' | 'create_alert' | 'execute_command';
type OnFailure = 'stop' | 'continue' | 'notify';

type Action = {
  type: ActionType;
  scriptId?: string;
  command?: string;
  alertSeverity?: string;
  alertMessage?: string;
  notificationChannelId?: string;
};

type AutomationItem = {
  name: string;
  enabled: boolean;
  triggerType: TriggerType;
  cronExpression: string;
  timezone: string;
  eventType: string;
  actions: Action[];
  onFailure: OnFailure;
};

const defaultItem: AutomationItem = {
  name: '',
  enabled: true,
  triggerType: 'schedule',
  cronExpression: '0 */6 * * *',
  timezone: 'UTC',
  eventType: '',
  actions: [{ type: 'run_script' }],
  onFailure: 'stop',
};

const timezoneOptions = [
  { value: 'UTC', label: 'UTC' },
  { value: 'America/New_York', label: 'Eastern (America/New_York)' },
  { value: 'America/Chicago', label: 'Central (America/Chicago)' },
  { value: 'America/Denver', label: 'Mountain (America/Denver)' },
  { value: 'America/Los_Angeles', label: 'Pacific (America/Los_Angeles)' },
  { value: 'Europe/London', label: 'Europe/London' },
  { value: 'Europe/Paris', label: 'Europe/Paris' },
  { value: 'Asia/Tokyo', label: 'Asia/Tokyo' },
  { value: 'Australia/Sydney', label: 'Australia/Sydney' },
];

const triggerOptions: { value: TriggerType; label: string; icon: React.ReactNode }[] = [
  { value: 'schedule', label: 'Schedule', icon: <Clock className="h-3.5 w-3.5" /> },
  { value: 'event', label: 'Event', icon: <Radio className="h-3.5 w-3.5" /> },
  { value: 'manual', label: 'Manual', icon: <Hand className="h-3.5 w-3.5" /> },
];

const actionTypeOptions: { value: ActionType; label: string }[] = [
  { value: 'run_script', label: 'Run Script' },
  { value: 'send_notification', label: 'Send Notification' },
  { value: 'create_alert', label: 'Create Alert' },
  { value: 'execute_command', label: 'Execute Command' },
];

const onFailureOptions: { value: OnFailure; label: string; description: string }[] = [
  { value: 'stop', label: 'Stop', description: 'Halt execution on first failure.' },
  { value: 'continue', label: 'Continue', description: 'Skip failed step and continue.' },
  { value: 'notify', label: 'Notify', description: 'Continue and send a notification.' },
];

const cronPresets = [
  { label: 'Every 5 min', value: '*/5 * * * *' },
  { label: 'Every hour', value: '0 * * * *' },
  { label: 'Every 6 hours', value: '0 */6 * * *' },
  { label: 'Daily at midnight', value: '0 0 * * *' },
  { label: 'Weekdays at 9am', value: '0 9 * * 1-5' },
  { label: 'Weekly (Sunday)', value: '0 0 * * 0' },
];

const eventTypes = [
  { value: 'device.offline', label: 'Device Offline' },
  { value: 'device.online', label: 'Device Online' },
  { value: 'alert.triggered', label: 'Alert Triggered' },
  { value: 'alert.resolved', label: 'Alert Resolved' },
  { value: 'compliance.failed', label: 'Compliance Failed' },
  { value: 'patch.available', label: 'Patch Available' },
];

function loadItems(existingLink: FeatureTabProps['existingLink']): AutomationItem[] {
  const raw = existingLink?.inlineSettings as Record<string, unknown> | null | undefined;
  if (!raw) return [];
  if (Array.isArray((raw as any).items)) {
    return (raw as any).items as AutomationItem[];
  }
  // Legacy single-item format
  if ((raw as any).triggerType) {
    const legacy = raw as unknown as Omit<AutomationItem, 'name'>;
    return [{ ...legacy, name: 'Automation 1' }];
  }
  return [];
}

function triggerSummary(item: AutomationItem): string {
  if (item.triggerType === 'schedule') {
    const tz = item.timezone && item.timezone !== 'UTC' ? ` (${item.timezone})` : '';
    return (item.cronExpression || 'No schedule') + tz;
  }
  if (item.triggerType === 'event') return item.eventType || 'No event';
  return 'Manual';
}

export default function AutomationTab({ policyId, existingLink, onLinkChanged, linkedPolicyId, parentLink }: FeatureTabProps) {
  const { save, remove, saving, error, clearError } = useFeatureLink(policyId);
  const isInherited = !!parentLink && !existingLink;
  const effectiveLink = existingLink ?? parentLink;
  const [items, setItems] = useState<AutomationItem[]>(() => loadItems(effectiveLink));
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setItems(loadItems(existingLink ?? parentLink));
  }, [existingLink, parentLink]);

  useEffect(() => {
    if (expandedIndex !== null) {
      const t = setTimeout(() => nameInputRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [expandedIndex]);

  const updateItem = (index: number, patch: Partial<AutomationItem>) => {
    setItems((prev) => prev.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  };

  const updateAction = (itemIndex: number, actionIndex: number, patch: Partial<Action>) => {
    setItems((prev) =>
      prev.map((item, i) => {
        if (i !== itemIndex) return item;
        const actions = item.actions.map((a, ai) => (ai === actionIndex ? { ...a, ...patch } : a));
        return { ...item, actions };
      })
    );
  };

  const addAction = (itemIndex: number) => {
    setItems((prev) =>
      prev.map((item, i) => {
        if (i !== itemIndex) return item;
        return { ...item, actions: [...item.actions, { type: 'run_script' as ActionType }] };
      })
    );
  };

  const removeAction = (itemIndex: number, actionIndex: number) => {
    setItems((prev) =>
      prev.map((item, i) => {
        if (i !== itemIndex) return item;
        return { ...item, actions: item.actions.filter((_, ai) => ai !== actionIndex) };
      })
    );
  };

  const addItem = () => {
    const newItem: AutomationItem = { ...defaultItem, name: `Automation ${items.length + 1}`, actions: [{ ...defaultItem.actions[0] }] };
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
      featureType: 'automation',
      featurePolicyId: linkedPolicyId,
      inlineSettings: { items },
    });
    if (result) onLinkChanged(result, 'automation');
  };

  const handleRemove = async () => {
    if (!existingLink) return;
    const ok = await remove(existingLink.id);
    if (ok) onLinkChanged(null, 'automation');
  };

  const handleOverride = async () => {
    clearError();
    const result = await save(null, {
      featureType: 'automation',
      featurePolicyId: linkedPolicyId,
      inlineSettings: { items },
    });
    if (result) onLinkChanged(result, 'automation');
  };

  const handleRevert = async () => {
    if (!existingLink) return;
    const ok = await remove(existingLink.id);
    if (ok) onLinkChanged(null, 'automation');
  };

  const meta = FEATURE_META.automation;

  return (
    <FeatureTabShell
      title={meta.label}
      description={meta.description}
      icon={<Zap className="h-5 w-5" />}
      isConfigured={!!existingLink || isInherited}
      saving={saving}
      error={error}
      onSave={handleSave}
      onRemove={existingLink && !linkedPolicyId ? handleRemove : undefined}
      isInherited={isInherited}
      onOverride={isInherited ? handleOverride : undefined}
      onRevert={!isInherited && !!linkedPolicyId && !!existingLink ? handleRevert : undefined}
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">Automations</h3>
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
          <Plus className="h-4 w-4" /> Add Automation
        </button>
      </div>

      {/* Empty state */}
      {items.length === 0 && (
        <div className="mt-4 rounded-md border border-dashed p-8 text-center">
          <Zap className="mx-auto h-8 w-8 text-muted-foreground/50" />
          <p className="mt-2 text-sm text-muted-foreground">No automations configured yet.</p>
          <button
            type="button"
            onClick={addItem}
            className="mt-3 inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            <Plus className="h-4 w-4" /> Add Automation
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
                  <span className="text-sm font-medium">{item.name || 'Untitled Automation'}</span>
                  <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium">
                    {triggerOptions.find((t) => t.value === item.triggerType)?.icon}
                    {triggerOptions.find((t) => t.value === item.triggerType)?.label}
                  </span>
                  <span className="text-xs text-muted-foreground">{triggerSummary(item)}</span>
                  {!item.enabled && (
                    <span className="rounded-full border border-yellow-500/40 bg-yellow-500/10 px-2 py-0.5 text-xs font-medium text-yellow-700">
                      Disabled
                    </span>
                  )}
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
                  {/* Name + Enabled */}
                  <div className="flex items-end gap-4">
                    <div className="flex-1">
                      <label className="text-xs font-medium text-muted-foreground">Automation Name</label>
                      <input
                        ref={nameInputRef}
                        value={item.name}
                        onChange={(e) => updateItem(index, { name: e.target.value })}
                        placeholder="e.g. Daily Disk Cleanup"
                        className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                      />
                    </div>
                    <label className="flex items-center gap-2 cursor-pointer pb-1">
                      <input
                        type="checkbox"
                        checked={item.enabled}
                        onChange={(e) => updateItem(index, { enabled: e.target.checked })}
                        className="h-4 w-4 rounded border-muted"
                      />
                      <span className="text-sm">Enabled</span>
                    </label>
                  </div>

                  {/* Trigger Type */}
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">Trigger</label>
                    <div className="mt-1.5 flex flex-wrap gap-2">
                      {triggerOptions.map((opt) => (
                        <button
                          key={opt.value}
                          type="button"
                          onClick={() => updateItem(index, { triggerType: opt.value })}
                          className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium transition ${
                            item.triggerType === opt.value
                              ? 'border-primary bg-primary/10 text-foreground'
                              : 'border-muted bg-background text-muted-foreground hover:bg-muted'
                          }`}
                        >
                          {opt.icon}
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Schedule config */}
                  {item.triggerType === 'schedule' && (
                    <div className="space-y-3">
                      <div>
                        <label className="text-xs font-medium text-muted-foreground">Cron Expression</label>
                        <input
                          value={item.cronExpression}
                          onChange={(e) => updateItem(index, { cronExpression: e.target.value })}
                          placeholder="0 */6 * * *"
                          className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring"
                        />
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {cronPresets.map((preset) => (
                            <button
                              key={preset.value}
                              type="button"
                              onClick={() => updateItem(index, { cronExpression: preset.value })}
                              className={`rounded-md border px-2 py-1 text-xs transition ${
                                item.cronExpression === preset.value
                                  ? 'border-primary bg-primary/10 text-foreground'
                                  : 'text-muted-foreground hover:bg-muted'
                              }`}
                            >
                              {preset.label}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div>
                        <label className="text-xs font-medium text-muted-foreground">Timezone</label>
                        <select
                          value={item.timezone || 'UTC'}
                          onChange={(e) => updateItem(index, { timezone: e.target.value })}
                          className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm"
                        >
                          {timezoneOptions.map((tz) => (
                            <option key={tz.value} value={tz.value}>{tz.label}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                  )}

                  {/* Event config */}
                  {item.triggerType === 'event' && (
                    <div>
                      <label className="text-xs font-medium text-muted-foreground">Event Type</label>
                      <select
                        value={item.eventType}
                        onChange={(e) => updateItem(index, { eventType: e.target.value })}
                        className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm"
                      >
                        <option value="">Select event...</option>
                        {eventTypes.map((e) => <option key={e.value} value={e.value}>{e.label}</option>)}
                      </select>
                    </div>
                  )}

                  {/* Actions */}
                  <div>
                    <div className="flex items-center justify-between">
                      <label className="text-xs font-medium text-muted-foreground">Actions</label>
                      <button
                        type="button"
                        onClick={() => addAction(index)}
                        className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted"
                      >
                        <Plus className="h-3 w-3" /> Add Action
                      </button>
                    </div>
                    <div className="mt-2 space-y-2">
                      {item.actions.map((action, ai) => (
                        <div key={ai} className="rounded-md border bg-muted/20 p-3">
                          <div className="flex items-start gap-2">
                            <div className="flex-1 space-y-2">
                              <div>
                                <label className="text-xs font-medium text-muted-foreground">Action Type</label>
                                <select
                                  value={action.type}
                                  onChange={(e) => updateAction(index, ai, { type: e.target.value as ActionType })}
                                  className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm"
                                >
                                  {actionTypeOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                                </select>
                              </div>

                              {action.type === 'run_script' && (
                                <div>
                                  <label className="text-xs font-medium text-muted-foreground">Script ID</label>
                                  <input
                                    value={action.scriptId ?? ''}
                                    onChange={(e) => updateAction(index, ai, { scriptId: e.target.value })}
                                    placeholder="UUID of script"
                                    className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm"
                                  />
                                </div>
                              )}

                              {action.type === 'execute_command' && (
                                <div>
                                  <label className="text-xs font-medium text-muted-foreground">Command</label>
                                  <input
                                    value={action.command ?? ''}
                                    onChange={(e) => updateAction(index, ai, { command: e.target.value })}
                                    placeholder="e.g. systemctl restart nginx"
                                    className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm font-mono"
                                  />
                                </div>
                              )}

                              {action.type === 'create_alert' && (
                                <div className="grid gap-2 sm:grid-cols-2">
                                  <div>
                                    <label className="text-xs font-medium text-muted-foreground">Severity</label>
                                    <select
                                      value={action.alertSeverity ?? 'medium'}
                                      onChange={(e) => updateAction(index, ai, { alertSeverity: e.target.value })}
                                      className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm"
                                    >
                                      <option value="critical">Critical</option>
                                      <option value="high">High</option>
                                      <option value="medium">Medium</option>
                                      <option value="low">Low</option>
                                      <option value="info">Info</option>
                                    </select>
                                  </div>
                                  <div>
                                    <label className="text-xs font-medium text-muted-foreground">Message</label>
                                    <input
                                      value={action.alertMessage ?? ''}
                                      onChange={(e) => updateAction(index, ai, { alertMessage: e.target.value })}
                                      placeholder="Alert message"
                                      className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm"
                                    />
                                  </div>
                                </div>
                              )}

                              {action.type === 'send_notification' && (
                                <div>
                                  <label className="text-xs font-medium text-muted-foreground">Notification Channel ID</label>
                                  <input
                                    value={action.notificationChannelId ?? ''}
                                    onChange={(e) => updateAction(index, ai, { notificationChannelId: e.target.value })}
                                    placeholder="UUID of notification channel"
                                    className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm"
                                  />
                                </div>
                              )}
                            </div>
                            <button
                              type="button"
                              onClick={() => removeAction(index, ai)}
                              disabled={item.actions.length <= 1}
                              className="mt-4 flex h-8 w-8 items-center justify-center rounded-md text-destructive hover:bg-muted disabled:opacity-50"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* On Failure */}
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">On Failure</label>
                    <div className="mt-1.5 grid gap-2 sm:grid-cols-3">
                      {onFailureOptions.map((opt) => (
                        <label
                          key={opt.value}
                          className={`flex cursor-pointer flex-col gap-1 rounded-md border p-3 text-sm transition ${
                            item.onFailure === opt.value
                              ? 'border-primary/40 bg-primary/10 text-primary'
                              : 'border-muted text-muted-foreground hover:text-foreground'
                          }`}
                        >
                          <input
                            type="radio"
                            name={`onFailure-${index}`}
                            value={opt.value}
                            checked={item.onFailure === opt.value}
                            onChange={() => updateItem(index, { onFailure: opt.value })}
                            className="hidden"
                          />
                          <span className="font-medium text-foreground">{opt.label}</span>
                          <span className="text-xs text-muted-foreground">{opt.description}</span>
                        </label>
                      ))}
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
