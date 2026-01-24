import { useCallback, useEffect, useMemo, useState } from 'react';
import { Save, ToggleLeft, ToggleRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';
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

const severityStyles: Record<AlertSeverity, string> = {
  critical: 'bg-red-500/20 text-red-700 border-red-500/40',
  high: 'bg-orange-500/20 text-orange-700 border-orange-500/40',
  medium: 'bg-yellow-500/20 text-yellow-700 border-yellow-500/40',
  low: 'bg-blue-500/20 text-blue-700 border-blue-500/40',
  info: 'bg-gray-500/20 text-gray-700 border-gray-500/40'
};

export default function AlertRuleEditor() {
  const [templates, setTemplates] = useState<TemplateOption[]>([]);
  const [targetsByType, setTargetsByType] = useState<Record<TargetType, TargetOption[]>>({
    org: [],
    site: [],
    group: [],
    device: []
  });
  const [templateId, setTemplateId] = useState('');
  const [targetType, setTargetType] = useState<TargetType>('site');
  const [targetId, setTargetId] = useState('');
  const [overrideEnabled, setOverrideEnabled] = useState(false);
  const [overrideSeverity, setOverrideSeverity] = useState<AlertSeverity>('high');
  const [overrideCooldown, setOverrideCooldown] = useState(20);
  const [active, setActive] = useState(true);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const [templatesRes, targetsRes] = await Promise.all([
        fetchWithAuth('/alerts/templates'),
        fetchWithAuth('/alerts/rules/targets')
      ]);

      if (templatesRes.status === 401 || targetsRes.status === 401) {
        window.location.href = '/login';
        return;
      }

      if (!templatesRes.ok) {
        throw new Error('Failed to fetch templates');
      }

      if (!targetsRes.ok) {
        throw new Error('Failed to fetch targets');
      }

      const templatesData = await templatesRes.json();
      const targetsData = await targetsRes.json();

      const templatesList = (templatesData.templates || []).map((t: TemplateOption) => ({
        id: t.id,
        name: t.name,
        severity: t.severity
      }));
      setTemplates(templatesList);

      if (templatesList.length > 0 && !templateId) {
        setTemplateId(templatesList[0].id);
      }

      const newTargetsByType: Record<TargetType, TargetOption[]> = {
        org: targetsData.organizations || [],
        site: targetsData.sites || [],
        group: targetsData.groups || [],
        device: targetsData.devices || []
      };
      setTargetsByType(newTargetsByType);

      if (newTargetsByType[targetType].length > 0 && !targetId) {
        setTargetId(newTargetsByType[targetType][0].id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load data');
    } finally {
      setIsLoading(false);
    }
  }, [templateId, targetType, targetId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const selectedTemplate = useMemo(
    () => templates.find(template => template.id === templateId) ?? templates[0],
    [templates, templateId]
  );

  const targetOptions = targetsByType[targetType];

  const handleTargetTypeChange = (value: TargetType) => {
    setTargetType(value);
    const newTargets = targetsByType[value];
    setTargetId(newTargets[0]?.id ?? '');
  };

  const handleSaveRule = async () => {
    if (!templateId || !targetId) return;

    setIsSaving(true);

    try {
      const response = await fetchWithAuth('/alerts/rules', {
        method: 'POST',
        body: JSON.stringify({
          templateId,
          targetType,
          targetId,
          active,
          overrides: overrideEnabled ? {
            severity: overrideSeverity,
            cooldown: overrideCooldown
          } : null
        })
      });

      if (response.status === 401) {
        window.location.href = '/login';
        return;
      }

      if (!response.ok) {
        throw new Error('Failed to save rule');
      }

      // Could show success notification here
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save rule');
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex h-48 items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        </div>
      </div>
    );
  }

  if (error && templates.length === 0) {
    return (
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex h-48 flex-col items-center justify-center gap-2 text-muted-foreground">
          <p>{error}</p>
          <button
            type="button"
            onClick={fetchData}
            className="text-sm text-primary hover:underline"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Alert Rule Editor</h2>
          <p className="text-sm text-muted-foreground">Bind templates to targets and override behavior.</p>
        </div>
        <button
          type="button"
          onClick={handleSaveRule}
          disabled={isSaving || !templateId || !targetId}
          className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
        >
          <Save className="h-4 w-4" />
          {isSaving ? 'Saving...' : 'Save rule'}
        </button>
      </div>

      {error && (
        <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

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
                  {templates.map(template => (
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
                    selectedTemplate ? severityStyles[selectedTemplate.severity] : ''
                  )}
                >
                  {selectedTemplate?.severity?.toUpperCase() ?? 'N/A'}
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
                  {targetOptions.length === 0 ? (
                    <option value="">No targets available</option>
                  ) : (
                    targetOptions.map(option => (
                      <option key={option.id} value={option.id}>
                        {option.name}
                      </option>
                    ))
                  )}
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
                <span className="font-medium">{selectedTemplate?.name ?? 'Not set'}</span>
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
