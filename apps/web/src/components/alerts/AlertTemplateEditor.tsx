import { useMemo, useState } from 'react';
import { Eye, Plus, Save, ToggleLeft, ToggleRight, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AlertSeverity } from './AlertList';

type MetricOption = 'cpu' | 'memory' | 'disk' | 'network' | 'latency';
type OperatorOption = '>' | '<' | '>=' | '<=' | '=' | '!=';

type Condition = {
  id: string;
  metric: MetricOption;
  operator: OperatorOption;
  threshold: number;
  duration: number;
};

type ConditionGroup = {
  id: string;
  logic: 'AND' | 'OR';
  conditions: Condition[];
};

const metricOptions: { value: MetricOption; label: string }[] = [
  { value: 'cpu', label: 'CPU usage' },
  { value: 'memory', label: 'Memory usage' },
  { value: 'disk', label: 'Disk space' },
  { value: 'network', label: 'Network throughput' },
  { value: 'latency', label: 'Latency' }
];

const operatorOptions: { value: OperatorOption; label: string }[] = [
  { value: '>', label: '> greater than' },
  { value: '>=', label: '>= greater or equal' },
  { value: '<', label: '< less than' },
  { value: '<=', label: '<= less or equal' },
  { value: '=', label: '= equal to' },
  { value: '!=', label: '!= not equal' }
];

const severityOptions: { value: AlertSeverity; label: string; className: string }[] = [
  { value: 'critical', label: 'Critical', className: 'bg-red-500/20 text-red-700 border-red-500/40' },
  { value: 'high', label: 'High', className: 'bg-orange-500/20 text-orange-700 border-orange-500/40' },
  { value: 'medium', label: 'Medium', className: 'bg-yellow-500/20 text-yellow-700 border-yellow-500/40' },
  { value: 'low', label: 'Low', className: 'bg-blue-500/20 text-blue-700 border-blue-500/40' },
  { value: 'info', label: 'Info', className: 'bg-gray-500/20 text-gray-700 border-gray-500/40' }
];

const variableOptions = [
  '{{device.name}}',
  '{{device.site}}',
  '{{device.group}}',
  '{{metric.name}}',
  '{{metric.value}}',
  '{{threshold}}'
];

const previewContext: Record<string, string> = {
  'device.name': 'EdgeRouter-13',
  'device.site': 'HQ Campus',
  'device.group': 'Core Network',
  'metric.name': 'CPU usage',
  'metric.value': '92%',
  threshold: '90%'
};

const makeId = () => Math.random().toString(36).slice(2, 10);

const initialGroups: ConditionGroup[] = [
  {
    id: makeId(),
    logic: 'AND',
    conditions: [
      { id: makeId(), metric: 'cpu', operator: '>', threshold: 90, duration: 10 },
      { id: makeId(), metric: 'latency', operator: '>=', threshold: 220, duration: 5 }
    ]
  },
  {
    id: makeId(),
    logic: 'OR',
    conditions: [{ id: makeId(), metric: 'memory', operator: '>', threshold: 85, duration: 15 }]
  }
];

const renderTemplate = (template: string) =>
  template.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_, key: string) => {
    const value = previewContext[key.trim()];
    return value ?? `{{${key}}}`;
  });

export default function AlertTemplateEditor() {
  const [name, setName] = useState('CPU Saturation');
  const [description, setDescription] = useState('Sustained CPU usage across core network devices.');
  const [severity, setSeverity] = useState<AlertSeverity>('critical');
  const [conditionGroups, setConditionGroups] = useState<ConditionGroup[]>(initialGroups);
  const [titleTemplate, setTitleTemplate] = useState('High {{metric.name}} on {{device.name}}');
  const [messageTemplate, setMessageTemplate] = useState(
    'Alert triggered for {{device.name}} in {{device.site}}. Current value: {{metric.value}} (threshold {{threshold}}).'
  );
  const [selectedVariable, setSelectedVariable] = useState(variableOptions[0]);
  const [autoResolve, setAutoResolve] = useState(true);
  const [resolveAfterMinutes, setResolveAfterMinutes] = useState(15);
  const [cooldownMinutes, setCooldownMinutes] = useState(30);
  const [showPreview, setShowPreview] = useState(false);

  const previewTitle = useMemo(() => renderTemplate(titleTemplate), [titleTemplate]);
  const previewMessage = useMemo(() => renderTemplate(messageTemplate), [messageTemplate]);

  const handleAddGroup = () => {
    setConditionGroups(prev => [
      ...prev,
      {
        id: makeId(),
        logic: 'AND',
        conditions: [{ id: makeId(), metric: 'cpu', operator: '>', threshold: 80, duration: 5 }]
      }
    ]);
  };

  const handleRemoveGroup = (groupId: string) => {
    setConditionGroups(prev => prev.filter(group => group.id !== groupId));
  };

  const handleGroupLogicChange = (groupId: string, logic: 'AND' | 'OR') => {
    setConditionGroups(prev =>
      prev.map(group => (group.id === groupId ? { ...group, logic } : group))
    );
  };

  const handleAddCondition = (groupId: string) => {
    setConditionGroups(prev =>
      prev.map(group =>
        group.id === groupId
          ? {
              ...group,
              conditions: [
                ...group.conditions,
                { id: makeId(), metric: 'cpu', operator: '>', threshold: 75, duration: 5 }
              ]
            }
          : group
      )
    );
  };

  const handleRemoveCondition = (groupId: string, conditionId: string) => {
    setConditionGroups(prev =>
      prev.map(group =>
        group.id === groupId
          ? {
              ...group,
              conditions: group.conditions.filter(condition => condition.id !== conditionId)
            }
          : group
      )
    );
  };

  const handleConditionUpdate = (
    groupId: string,
    conditionId: string,
    updates: Partial<Condition>
  ) => {
    setConditionGroups(prev =>
      prev.map(group =>
        group.id === groupId
          ? {
              ...group,
              conditions: group.conditions.map(condition =>
                condition.id === conditionId ? { ...condition, ...updates } : condition
              )
            }
          : group
      )
    );
  };

  const handleInsertVariable = () => {
    setTitleTemplate(prev => `${prev} ${selectedVariable}`.trim());
  };

  return (
    <div className="space-y-6">
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold">Alert Template Editor</h2>
            <p className="text-sm text-muted-foreground">Define how this template behaves and what it says.</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowPreview(true)}
              className="inline-flex h-10 items-center gap-2 rounded-md border bg-background px-4 text-sm font-medium hover:bg-muted"
            >
              <Eye className="h-4 w-4" />
              Preview
            </button>
            <button
              type="button"
              className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90"
            >
              <Save className="h-4 w-4" />
              Save template
            </button>
          </div>
        </div>

        <div className="mt-6 grid gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2 space-y-6">
            <div className="rounded-md border p-4">
              <h3 className="text-sm font-semibold">Basics</h3>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="text-xs font-medium uppercase text-muted-foreground">Name</label>
                  <input
                    value={name}
                    onChange={event => setName(event.target.value)}
                    className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium uppercase text-muted-foreground">Severity</label>
                  <div className="mt-1 grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {severityOptions.map(option => (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => setSeverity(option.value)}
                        className={cn(
                          'rounded-md border px-3 py-2 text-xs font-medium transition',
                          severity === option.value
                            ? option.className
                            : 'border-muted bg-background text-muted-foreground hover:text-foreground'
                        )}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="sm:col-span-2">
                  <label className="text-xs font-medium uppercase text-muted-foreground">Description</label>
                  <input
                    value={description}
                    onChange={event => setDescription(event.target.value)}
                    className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
              </div>
            </div>

            <div className="rounded-md border p-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-semibold">Conditions Builder</h3>
                  <p className="text-xs text-muted-foreground">Groups are evaluated top to bottom and combined with OR.</p>
                </div>
                <button
                  type="button"
                  onClick={handleAddGroup}
                  className="inline-flex h-8 items-center gap-2 rounded-md border px-3 text-xs font-medium hover:bg-muted"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Add group
                </button>
              </div>

              <div className="mt-4 space-y-4">
                {conditionGroups.map((group, groupIndex) => (
                  <div key={group.id} className="rounded-md border bg-muted/30 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold uppercase text-muted-foreground">
                          Group {groupIndex + 1}
                        </span>
                        <select
                          value={group.logic}
                          onChange={event =>
                            handleGroupLogicChange(group.id, event.target.value as 'AND' | 'OR')
                          }
                          className="h-8 rounded-md border bg-background px-2 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
                        >
                          <option value="AND">AND</option>
                          <option value="OR">OR</option>
                        </select>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleRemoveGroup(group.id)}
                        className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs font-medium text-destructive hover:bg-destructive/10"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        Remove group
                      </button>
                    </div>

                    <div className="mt-3 space-y-3">
                      {group.conditions.map(condition => (
                        <div
                          key={condition.id}
                          className="grid grid-cols-1 gap-2 rounded-md border bg-background p-3 sm:grid-cols-[1.3fr_1fr_1fr_1fr_auto]"
                        >
                          <select
                            value={condition.metric}
                            onChange={event =>
                              handleConditionUpdate(group.id, condition.id, {
                                metric: event.target.value as MetricOption
                              })
                            }
                            className="h-9 rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                          >
                            {metricOptions.map(option => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                          <select
                            value={condition.operator}
                            onChange={event =>
                              handleConditionUpdate(group.id, condition.id, {
                                operator: event.target.value as OperatorOption
                              })
                            }
                            className="h-9 rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                          >
                            {operatorOptions.map(option => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                          <input
                            type="number"
                            value={condition.threshold}
                            onChange={event =>
                              handleConditionUpdate(group.id, condition.id, {
                                threshold: Number(event.target.value)
                              })
                            }
                            className="h-9 rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                          />
                          <input
                            type="number"
                            value={condition.duration}
                            onChange={event =>
                              handleConditionUpdate(group.id, condition.id, {
                                duration: Number(event.target.value)
                              })
                            }
                            className="h-9 rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                          />
                          <button
                            type="button"
                            onClick={() => handleRemoveCondition(group.id, condition.id)}
                            className="inline-flex h-9 items-center justify-center rounded-md border px-2 text-sm text-destructive hover:bg-destructive/10"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      ))}
                    </div>
                    <button
                      type="button"
                      onClick={() => handleAddCondition(group.id)}
                      className="mt-3 inline-flex h-8 items-center gap-2 rounded-md border px-3 text-xs font-medium hover:bg-muted"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      Add condition
                    </button>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-md border p-4">
              <h3 className="text-sm font-semibold">Template Content</h3>
              <div className="mt-4 space-y-4">
                <div>
                  <label className="text-xs font-medium uppercase text-muted-foreground">Title template</label>
                  <input
                    value={titleTemplate}
                    onChange={event => setTitleTemplate(event.target.value)}
                    className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <select
                      value={selectedVariable}
                      onChange={event => setSelectedVariable(event.target.value)}
                      className="h-8 rounded-md border bg-background px-2 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
                    >
                      {variableOptions.map(variable => (
                        <option key={variable} value={variable}>
                          {variable}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={handleInsertVariable}
                      className="inline-flex h-8 items-center gap-2 rounded-md border px-3 text-xs font-medium hover:bg-muted"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      Insert variable
                    </button>
                    <div className="flex flex-wrap gap-2">
                      {variableOptions.slice(0, 3).map(variable => (
                        <button
                          key={variable}
                          type="button"
                          onClick={() => setTitleTemplate(prev => `${prev} ${variable}`.trim())}
                          className="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
                        >
                          {variable}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
                <div>
                  <label className="text-xs font-medium uppercase text-muted-foreground">Message template</label>
                  <textarea
                    value={messageTemplate}
                    onChange={event => setMessageTemplate(event.target.value)}
                    rows={5}
                    className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
              </div>
            </div>
          </div>

          <div className="space-y-6">
            <div className="rounded-md border p-4">
              <h3 className="text-sm font-semibold">Auto-resolve</h3>
              <button
                type="button"
                onClick={() => setAutoResolve(prev => !prev)}
                className={cn(
                  'mt-4 flex w-full items-center justify-between rounded-md border px-3 py-2 text-sm font-medium transition',
                  autoResolve
                    ? 'bg-emerald-500/15 text-emerald-700 border-emerald-500/30'
                    : 'bg-muted text-muted-foreground'
                )}
              >
                {autoResolve ? 'Auto-resolve enabled' : 'Auto-resolve disabled'}
                {autoResolve ? <ToggleRight className="h-5 w-5" /> : <ToggleLeft className="h-5 w-5" />}
              </button>
              <p className="mt-3 text-xs text-muted-foreground">
                Automatically resolve alerts after conditions clear for a sustained period.
              </p>
              {autoResolve && (
                <div className="mt-4">
                  <label className="text-xs font-medium uppercase text-muted-foreground">
                    Resolve after (minutes)
                  </label>
                  <input
                    type="number"
                    value={resolveAfterMinutes}
                    onChange={event => setResolveAfterMinutes(Number(event.target.value))}
                    className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
              )}
            </div>

            <div className="rounded-md border p-4">
              <h3 className="text-sm font-semibold">Cooldown</h3>
              <p className="mt-2 text-xs text-muted-foreground">
                Prevent repeated alerts for the same condition during the cooldown window.
              </p>
              <div className="mt-4">
                <label className="text-xs font-medium uppercase text-muted-foreground">Cooldown minutes</label>
                <input
                  type="number"
                  value={cooldownMinutes}
                  onChange={event => setCooldownMinutes(Number(event.target.value))}
                  className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
            </div>

            {showPreview && (
              <div className="rounded-md border bg-muted/30 p-4">
                <h3 className="text-sm font-semibold">Preview</h3>
                <div className="mt-3 rounded-md border bg-background p-3">
                  <p className="text-sm font-medium">{previewTitle}</p>
                  <p className="mt-2 text-sm text-muted-foreground">{previewMessage}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <span className="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground">
                      Severity: {severity}
                    </span>
                    <span className="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground">
                      Cooldown: {cooldownMinutes}m
                    </span>
                    {autoResolve && (
                      <span className="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground">
                        Auto-resolve: {resolveAfterMinutes}m
                      </span>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
