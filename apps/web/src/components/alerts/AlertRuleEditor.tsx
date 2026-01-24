import { useMemo, useState } from 'react';
import { Save, ToggleLeft, ToggleRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AlertSeverity } from './AlertList';

type TargetType = 'org' | 'site' | 'group' | 'device';

type TemplateOption = {
  id: string;
  name: string;
  severity: AlertSeverity;
};

type TargetOption = {
  id: string;
  name: string;
};

const mockTemplates: TemplateOption[] = [
  { id: 'tmpl-001', name: 'CPU Saturation', severity: 'critical' },
  { id: 'tmpl-002', name: 'Memory Pressure', severity: 'high' },
  { id: 'tmpl-003', name: 'Disk Space Risk', severity: 'medium' },
  { id: 'tmpl-004', name: 'Patch Compliance Drift', severity: 'low' }
];

const targetsByType: Record<TargetType, TargetOption[]> = {
  org: [{ id: 'org-all', name: 'All Sites' }],
  site: [
    { id: 'site-1', name: 'HQ Campus' },
    { id: 'site-2', name: 'West DC' },
    { id: 'site-3', name: 'EMEA Region' }
  ],
  group: [
    { id: 'group-1', name: 'Core Servers' },
    { id: 'group-2', name: 'Remote Workstations' },
    { id: 'group-3', name: 'Linux Fleet' }
  ],
  device: [
    { id: 'device-1', name: 'WAN-Gateway-07' },
    { id: 'device-2', name: 'DB-Primary-02' },
    { id: 'device-3', name: 'EdgeRouter-13' }
  ]
};

const severityStyles: Record<AlertSeverity, string> = {
  critical: 'bg-red-500/20 text-red-700 border-red-500/40',
  high: 'bg-orange-500/20 text-orange-700 border-orange-500/40',
  medium: 'bg-yellow-500/20 text-yellow-700 border-yellow-500/40',
  low: 'bg-blue-500/20 text-blue-700 border-blue-500/40',
  info: 'bg-gray-500/20 text-gray-700 border-gray-500/40'
};

export default function AlertRuleEditor() {
  const [templateId, setTemplateId] = useState(mockTemplates[0].id);
  const [targetType, setTargetType] = useState<TargetType>('site');
  const [targetId, setTargetId] = useState(targetsByType.site[0].id);
  const [overrideEnabled, setOverrideEnabled] = useState(false);
  const [overrideSeverity, setOverrideSeverity] = useState<AlertSeverity>('high');
  const [overrideCooldown, setOverrideCooldown] = useState(20);
  const [active, setActive] = useState(true);

  const selectedTemplate = useMemo(
    () => mockTemplates.find(template => template.id === templateId) ?? mockTemplates[0],
    [templateId]
  );

  const targetOptions = targetsByType[targetType];

  const handleTargetTypeChange = (value: TargetType) => {
    setTargetType(value);
    setTargetId(targetsByType[value][0]?.id ?? '');
  };

  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Alert Rule Editor</h2>
          <p className="text-sm text-muted-foreground">Bind templates to targets and override behavior.</p>
        </div>
        <button
          type="button"
          className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90"
        >
          <Save className="h-4 w-4" />
          Save rule
        </button>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-6">
          <div className="rounded-md border p-4">
            <h3 className="text-sm font-semibold">Template Selection</h3>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div>
                <label className="text-xs font-medium uppercase text-muted-foreground">Template</label>
                <select
                  value={templateId}
                  onChange={event => setTemplateId(event.target.value)}
                  className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  {mockTemplates.map(template => (
                    <option key={template.id} value={template.id}>
                      {template.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs font-medium uppercase text-muted-foreground">Template severity</label>
                <div
                  className={cn(
                    'mt-1 flex h-10 items-center rounded-md border px-3 text-sm font-medium',
                    severityStyles[selectedTemplate.severity]
                  )}
                >
                  {selectedTemplate.severity.toUpperCase()}
                </div>
              </div>
            </div>
          </div>

          <div className="rounded-md border p-4">
            <h3 className="text-sm font-semibold">Targets</h3>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div>
                <label className="text-xs font-medium uppercase text-muted-foreground">Target type</label>
                <select
                  value={targetType}
                  onChange={event => handleTargetTypeChange(event.target.value as TargetType)}
                  className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="org">Organization</option>
                  <option value="site">Site</option>
                  <option value="group">Group</option>
                  <option value="device">Device</option>
                </select>
              </div>
              <div>
                <label className="text-xs font-medium uppercase text-muted-foreground">Target</label>
                <select
                  value={targetId}
                  onChange={event => setTargetId(event.target.value)}
                  className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  {targetOptions.map(option => (
                    <option key={option.id} value={option.id}>
                      {option.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          <div className="rounded-md border p-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold">Override settings</h3>
                <p className="text-xs text-muted-foreground">Optional rule-level overrides.</p>
              </div>
              <button
                type="button"
                onClick={() => setOverrideEnabled(prev => !prev)}
                className={cn(
                  'flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs font-medium transition',
                  overrideEnabled
                    ? 'bg-emerald-500/15 text-emerald-700 border-emerald-500/30'
                    : 'bg-muted text-muted-foreground'
                )}
              >
                {overrideEnabled ? 'Overrides on' : 'Overrides off'}
                {overrideEnabled ? <ToggleRight className="h-4 w-4" /> : <ToggleLeft className="h-4 w-4" />}
              </button>
            </div>

            {overrideEnabled && (
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="text-xs font-medium uppercase text-muted-foreground">Severity override</label>
                  <select
                    value={overrideSeverity}
                    onChange={event => setOverrideSeverity(event.target.value as AlertSeverity)}
                    className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  >
                    <option value="critical">Critical</option>
                    <option value="high">High</option>
                    <option value="medium">Medium</option>
                    <option value="low">Low</option>
                    <option value="info">Info</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium uppercase text-muted-foreground">Cooldown override</label>
                  <input
                    type="number"
                    value={overrideCooldown}
                    onChange={event => setOverrideCooldown(Number(event.target.value))}
                    className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="space-y-6">
          <div className="rounded-md border p-4">
            <h3 className="text-sm font-semibold">Rule Status</h3>
            <p className="mt-2 text-xs text-muted-foreground">Toggle the rule on or off without deleting it.</p>
            <button
              type="button"
              onClick={() => setActive(prev => !prev)}
              className={cn(
                'mt-4 flex w-full items-center justify-between rounded-md border px-3 py-2 text-sm font-medium transition',
                active ? 'bg-emerald-500/20 text-emerald-700 border-emerald-500/30' : 'bg-muted text-muted-foreground'
              )}
            >
              {active ? 'Active' : 'Paused'}
              {active ? <ToggleRight className="h-5 w-5" /> : <ToggleLeft className="h-5 w-5" />}
            </button>
          </div>

          <div className="rounded-md border p-4">
            <h3 className="text-sm font-semibold">Summary</h3>
            <div className="mt-3 space-y-2 text-sm">
              <p className="flex justify-between">
                <span className="text-muted-foreground">Template</span>
                <span className="font-medium">{selectedTemplate.name}</span>
              </p>
              <p className="flex justify-between">
                <span className="text-muted-foreground">Target type</span>
                <span className="font-medium">{targetType}</span>
              </p>
              <p className="flex justify-between">
                <span className="text-muted-foreground">Target</span>
                <span className="font-medium">
                  {targetOptions.find(option => option.id === targetId)?.name ?? 'Not set'}
                </span>
              </p>
              {overrideEnabled && (
                <p className="flex justify-between">
                  <span className="text-muted-foreground">Override severity</span>
                  <span className="font-medium">{overrideSeverity}</span>
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
