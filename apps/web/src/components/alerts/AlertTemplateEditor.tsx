import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, Save, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AlertSeverity } from './AlertList';

type AlertTemplateEditorProps = {
  templateId?: string;
};

type MetricOption = 'cpu.usage' | 'memory.usage' | 'disk.free' | 'network.throughput' | 'latency.ms';

type OperatorOption = '>' | '>=' | '<' | '<=' | '=' | '!=';

type EventSourceOption = 'device.status' | 'service.health' | 'security.event' | 'integration.event';

type MetricCondition = {
  id: string;
  type: 'metric';
  metric: MetricOption;
  operator: OperatorOption;
  threshold: number;
  durationMinutes: number;
  occurrences: number;
};

type EventCondition = {
  id: string;
  type: 'event';
  eventSource: EventSourceOption;
  pattern: string;
};

type AlertCondition = MetricCondition | EventCondition;

type ThresholdDefaults = {
  value: number;
  durationMinutes: number;
  occurrences: number;
};

type NotificationRouting = {
  email: boolean;
  sms: boolean;
  webhook: boolean;
  ticket: boolean;
};

type NotificationRoute = keyof NotificationRouting;

type EscalationRule = {
  id: string;
  afterMinutes: number;
  severity: AlertSeverity;
  route: NotificationRoute;
};

type AutoRemediation = {
  enabled: boolean;
  automationId: string;
};

type MaintenanceWindow = {
  id: string;
  name: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
};

type SuppressionRules = {
  suppressDuplicates: boolean;
  duplicateSuppressionMinutes: number;
  maintenanceWindows: MaintenanceWindow[];
};

type TargetScopeType = 'organization' | 'site' | 'group';

type TargetScope = {
  type: TargetScopeType;
  orgIds: string[];
  siteIds: string[];
  groupIds: string[];
};

type TargetScopeKey = 'orgIds' | 'siteIds' | 'groupIds';

type Option = {
  id: string;
  name: string;
};

type TemplateConditionsPayload = {
  triggers: AlertCondition[];
  thresholdDefaults: ThresholdDefaults;
  notifications: NotificationRouting;
  escalationRules: EscalationRule[];
  autoRemediation: AutoRemediation;
  suppression: SuppressionRules;
};

type AlertTemplateResponse = {
  id: string;
  name: string;
  description?: string;
  category?: string;
  severity: AlertSeverity;
  builtIn?: boolean;
  conditions?: Partial<TemplateConditionsPayload>;
  targets?: Record<string, unknown>;
  defaultCooldownMinutes?: number;
};

const categoryOptions = [
  'Performance',
  'Availability',
  'Security',
  'Compliance',
  'Capacity',
  'Operations',
  'Custom'
];

const metricOptions: { value: MetricOption; label: string }[] = [
  { value: 'cpu.usage', label: 'CPU usage' },
  { value: 'memory.usage', label: 'Memory usage' },
  { value: 'disk.free', label: 'Disk free space' },
  { value: 'network.throughput', label: 'Network throughput' },
  { value: 'latency.ms', label: 'Latency (ms)' }
];

const operatorOptions: { value: OperatorOption; label: string }[] = [
  { value: '>', label: '> greater than' },
  { value: '>=', label: '>= greater or equal' },
  { value: '<', label: '< less than' },
  { value: '<=', label: '<= less or equal' },
  { value: '=', label: '= equal to' },
  { value: '!=', label: '!= not equal' }
];

const eventSourceOptions: { value: EventSourceOption; label: string }[] = [
  { value: 'device.status', label: 'Device status change' },
  { value: 'service.health', label: 'Service health event' },
  { value: 'security.event', label: 'Security event' },
  { value: 'integration.event', label: 'Integration signal' }
];

const severityOptions: { value: AlertSeverity; label: string; className: string }[] = [
  { value: 'critical', label: 'Critical', className: 'bg-red-500/20 text-red-700 border-red-500/40' },
  { value: 'high', label: 'High', className: 'bg-orange-500/20 text-orange-700 border-orange-500/40' },
  { value: 'medium', label: 'Medium', className: 'bg-yellow-500/20 text-yellow-700 border-yellow-500/40' },
  { value: 'low', label: 'Low', className: 'bg-blue-500/20 text-blue-700 border-blue-500/40' },
  { value: 'info', label: 'Info', className: 'bg-gray-500/20 text-gray-700 border-gray-500/40' }
];

const notificationOptions: {
  id: NotificationRoute;
  label: string;
  description: string;
}[] = [
  { id: 'email', label: 'Email', description: 'Send emails to the on-call roster.' },
  { id: 'sms', label: 'SMS', description: 'Notify via SMS for urgent outages.' },
  { id: 'webhook', label: 'Webhook', description: 'POST to custom integrations.' },
  { id: 'ticket', label: 'Ticket', description: 'Create a ticket in your ITSM tool.' }
];

const escalationRoutes: { value: NotificationRoute; label: string }[] = [
  { value: 'email', label: 'Email' },
  { value: 'sms', label: 'SMS' },
  { value: 'webhook', label: 'Webhook' },
  { value: 'ticket', label: 'Ticket' }
];

const timezones = ['UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles'];

const defaultThresholdDefaults: ThresholdDefaults = {
  value: 90,
  durationMinutes: 10,
  occurrences: 3
};

const defaultNotificationRouting: NotificationRouting = {
  email: true,
  sms: false,
  webhook: false,
  ticket: false
};

const defaultEscalationRules: EscalationRule[] = [
  { id: 'esc-1', afterMinutes: 15, severity: 'high', route: 'email' }
];

const defaultSuppressionRules: SuppressionRules = {
  suppressDuplicates: true,
  duplicateSuppressionMinutes: 30,
  maintenanceWindows: []
};

const defaultTargetScope: TargetScope = {
  type: 'organization',
  orgIds: [],
  siteIds: [],
  groupIds: []
};

let idCounter = 0;
const createId = (prefix: string = 'id') => {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
};

const makeId = () => createId('id');

const createMetricCondition = (defaults: ThresholdDefaults): MetricCondition => ({
  id: makeId(),
  type: 'metric',
  metric: 'cpu.usage',
  operator: '>',
  threshold: defaults.value,
  durationMinutes: defaults.durationMinutes,
  occurrences: defaults.occurrences
});

const createEventCondition = (): EventCondition => ({
  id: makeId(),
  type: 'event',
  eventSource: 'device.status',
  pattern: 'offline|critical'
});

const normalizeNumber = (value: unknown, fallback: number) =>
  typeof value === 'number' && !Number.isNaN(value) ? value : fallback;

const normalizeTargets = (targets?: Record<string, unknown>): TargetScope => {
  if (!targets) {
    return { ...defaultTargetScope };
  }

  const rawScope = typeof targets.scope === 'string' ? targets.scope : '';
  const scope: TargetScopeType =
    rawScope === 'site' || rawScope === 'group' || rawScope === 'organization'
      ? rawScope
      : 'organization';
  const orgIds = Array.isArray(targets.orgIds)
    ? (targets.orgIds as string[])
    : targets.orgId
      ? [targets.orgId as string]
      : [];
  const siteIds = Array.isArray(targets.siteIds) ? (targets.siteIds as string[]) : [];
  const groupIds = Array.isArray(targets.groupIds)
    ? (targets.groupIds as string[])
    : Array.isArray(targets.tags)
      ? (targets.tags as string[])
      : [];

  return {
    type: scope,
    orgIds,
    siteIds,
    groupIds
  };
};

const normalizeConditions = (
  payload: Partial<TemplateConditionsPayload> | undefined,
  defaults: ThresholdDefaults
): AlertCondition[] => {
  const triggers = Array.isArray(payload?.triggers) ? payload?.triggers : [];

  if (!triggers || triggers.length === 0) {
    return [createMetricCondition(defaults)];
  }

  return triggers.map(trigger => {
    if (trigger.type === 'event' || 'eventSource' in trigger) {
      return {
        id: (trigger as EventCondition).id ?? makeId(),
        type: 'event',
        eventSource: (trigger as EventCondition).eventSource ?? 'device.status',
        pattern: (trigger as EventCondition).pattern ?? ''
      };
    }

    const metricTrigger = trigger as MetricCondition;
    return {
      id: metricTrigger.id ?? makeId(),
      type: 'metric',
      metric: metricTrigger.metric ?? 'cpu.usage',
      operator: metricTrigger.operator ?? '>',
      threshold: normalizeNumber(metricTrigger.threshold, defaults.value),
      durationMinutes: normalizeNumber(metricTrigger.durationMinutes, defaults.durationMinutes),
      occurrences: normalizeNumber(metricTrigger.occurrences, defaults.occurrences)
    };
  });
};

const normalizeEscalationRules = (rules?: EscalationRule[]) => {
  if (!Array.isArray(rules) || rules.length === 0) {
    return defaultEscalationRules.map(rule => ({ ...rule, id: makeId() }));
  }

  return rules.map(rule => ({
    id: rule.id ?? makeId(),
    afterMinutes: normalizeNumber(rule.afterMinutes, 15),
    severity: rule.severity ?? 'high',
    route: rule.route ?? 'email'
  }));
};

const normalizeSuppressionRules = (
  suppression?: SuppressionRules,
  defaultCooldownMinutes?: number
): SuppressionRules => {
  const duplicateMinutes = normalizeNumber(
    suppression?.duplicateSuppressionMinutes,
    normalizeNumber(defaultCooldownMinutes, defaultSuppressionRules.duplicateSuppressionMinutes)
  );

  return {
    suppressDuplicates: suppression?.suppressDuplicates ?? true,
    duplicateSuppressionMinutes: duplicateMinutes,
    maintenanceWindows: Array.isArray(suppression?.maintenanceWindows)
      ? suppression?.maintenanceWindows.map(window => ({
          id: window.id ?? makeId(),
          name: window.name ?? 'Maintenance window',
          startsAt: window.startsAt ?? '',
          endsAt: window.endsAt ?? '',
          timezone: window.timezone ?? 'UTC'
        }))
      : []
  };
};

const stripConditionIds = (conditions: AlertCondition[]) =>
  conditions.map(condition => {
    if (condition.type === 'event') {
      return {
        type: 'event',
        eventSource: condition.eventSource,
        pattern: condition.pattern
      };
    }

    return {
      type: 'metric',
      metric: condition.metric,
      operator: condition.operator,
      threshold: condition.threshold,
      durationMinutes: condition.durationMinutes,
      occurrences: condition.occurrences
    };
  });

const stripEscalationIds = (rules: EscalationRule[]) =>
  rules.map(rule => ({
    afterMinutes: rule.afterMinutes,
    severity: rule.severity,
    route: rule.route
  }));

export default function AlertTemplateEditor({ templateId }: AlertTemplateEditorProps) {
  const [loading, setLoading] = useState(true);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState(categoryOptions[0]);
  const [severity, setSeverity] = useState<AlertSeverity>('medium');
  const [thresholdDefaults, setThresholdDefaults] = useState<ThresholdDefaults>(
    defaultThresholdDefaults
  );
  const [conditions, setConditions] = useState<AlertCondition[]>([
    createMetricCondition(defaultThresholdDefaults)
  ]);
  const [notificationRouting, setNotificationRouting] =
    useState<NotificationRouting>(defaultNotificationRouting);
  const [escalationRules, setEscalationRules] = useState<EscalationRule[]>(
    defaultEscalationRules.map(rule => ({ ...rule, id: makeId() }))
  );
  const [autoRemediation, setAutoRemediation] = useState<AutoRemediation>({
    enabled: false,
    automationId: ''
  });
  const [suppressionRules, setSuppressionRules] = useState<SuppressionRules>(
    defaultSuppressionRules
  );
  const [targetScope, setTargetScope] = useState<TargetScope>(defaultTargetScope);

  const [organizations, setOrganizations] = useState<Option[]>([]);
  const [sites, setSites] = useState<Option[]>([]);
  const [groups, setGroups] = useState<Option[]>([]);
  const [automations, setAutomations] = useState<Option[]>([]);

  const targetKeyByType: Record<TargetScopeType, TargetScopeKey> = {
    organization: 'orgIds',
    site: 'siteIds',
    group: 'groupIds'
  };

  const targetOptions = useMemo(() => {
    switch (targetScope.type) {
      case 'site':
        return sites;
      case 'group':
        return groups;
      default:
        return organizations;
    }
  }, [targetScope.type, organizations, sites, groups]);

  const selectedTargetIds = targetScope[targetKeyByType[targetScope.type]];

  const loadTemplate = useCallback(async () => {
    if (!templateId) {
      setError('Missing alert template id.');
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      setError(undefined);
      const response = await fetch(`/api/alert-templates/${templateId}`);
      if (!response.ok) {
        throw new Error('Failed to fetch alert template.');
      }
      const data = await response.json();
      const template = (data.data ?? data.template ?? data) as AlertTemplateResponse;

      const conditionsPayload = template.conditions ?? {};
      const thresholdDefaultsPayload = conditionsPayload.thresholdDefaults ?? {};
      const normalizedThresholds = {
        value: normalizeNumber(thresholdDefaultsPayload.value, defaultThresholdDefaults.value),
        durationMinutes: normalizeNumber(
          thresholdDefaultsPayload.durationMinutes,
          defaultThresholdDefaults.durationMinutes
        ),
        occurrences: normalizeNumber(
          thresholdDefaultsPayload.occurrences,
          defaultThresholdDefaults.occurrences
        )
      };

      setName(template.name ?? '');
      setDescription(template.description ?? '');
      setCategory(template.category ?? categoryOptions[0]);
      setSeverity(template.severity ?? 'medium');
      setThresholdDefaults(normalizedThresholds);
      setConditions(normalizeConditions(conditionsPayload, normalizedThresholds));
      setNotificationRouting({
        ...defaultNotificationRouting,
        ...(conditionsPayload.notifications ?? {})
      });
      setEscalationRules(normalizeEscalationRules(conditionsPayload.escalationRules));
      setAutoRemediation({
        enabled: conditionsPayload.autoRemediation?.enabled ?? false,
        automationId: conditionsPayload.autoRemediation?.automationId ?? ''
      });
      setSuppressionRules(
        normalizeSuppressionRules(conditionsPayload.suppression, template.defaultCooldownMinutes)
      );
      setTargetScope(normalizeTargets(template.targets));

      setHasLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred.');
    } finally {
      setLoading(false);
    }
  }, [templateId]);

  const fetchOrganizations = useCallback(async () => {
    try {
      const response = await fetch('/api/organizations');
      if (response.ok) {
        const data = await response.json();
        setOrganizations((data.organizations ?? data ?? []).map((org: Option) => ({
          id: org.id,
          name: org.name
        })));
      }
    } catch {
      // Silently fail
    }
  }, []);

  const fetchSites = useCallback(async () => {
    try {
      const response = await fetch('/api/sites');
      if (response.ok) {
        const data = await response.json();
        setSites((data.sites ?? data ?? []).map((site: Option) => ({
          id: site.id,
          name: site.name
        })));
      }
    } catch {
      // Silently fail
    }
  }, []);

  const fetchGroups = useCallback(async () => {
    try {
      const response = await fetch('/api/groups');
      if (response.ok) {
        const data = await response.json();
        setGroups((data.groups ?? data ?? []).map((group: Option) => ({
          id: group.id,
          name: group.name
        })));
      }
    } catch {
      // Silently fail
    }
  }, []);

  const fetchAutomations = useCallback(async () => {
    try {
      const response = await fetch('/api/automations');
      if (response.ok) {
        const data = await response.json();
        setAutomations((data.automations ?? data ?? []).map((automation: Option) => ({
          id: automation.id,
          name: automation.name
        })));
      }
    } catch {
      // Silently fail
    }
  }, []);

  useEffect(() => {
    loadTemplate();
    fetchOrganizations();
    fetchSites();
    fetchGroups();
    fetchAutomations();
  }, [loadTemplate, fetchOrganizations, fetchSites, fetchGroups, fetchAutomations]);

  const handleConditionUpdate = (id: string, updates: Partial<AlertCondition>) => {
    setConditions(prev =>
      prev.map(condition => (condition.id === id ? { ...condition, ...updates } : condition))
    );
  };

  const handleConditionTypeChange = (id: string, type: AlertCondition['type']) => {
    setConditions(prev =>
      prev.map(condition => {
        if (condition.id !== id) {
          return condition;
        }

        if (type === 'event') {
          return { ...createEventCondition(), id };
        }

        return { ...createMetricCondition(thresholdDefaults), id };
      })
    );
  };

  const handleAddCondition = (type: AlertCondition['type']) => {
    setConditions(prev =>
      type === 'event' ? [...prev, createEventCondition()] : [...prev, createMetricCondition(thresholdDefaults)]
    );
  };

  const handleRemoveCondition = (id: string) => {
    setConditions(prev => prev.filter(condition => condition.id !== id));
  };

  const handleRoutingToggle = (id: NotificationRoute) => {
    setNotificationRouting(prev => ({
      ...prev,
      [id]: !prev[id]
    }));
  };

  const handleEscalationUpdate = (id: string, updates: Partial<EscalationRule>) => {
    setEscalationRules(prev => prev.map(rule => (rule.id === id ? { ...rule, ...updates } : rule)));
  };

  const handleAddEscalation = () => {
    setEscalationRules(prev => [
      ...prev,
      {
        id: makeId(),
        afterMinutes: 30,
        severity: 'critical',
        route: 'sms'
      }
    ]);
  };

  const handleRemoveEscalation = (id: string) => {
    setEscalationRules(prev => prev.filter(rule => rule.id !== id));
  };

  const handleMaintenanceUpdate = (id: string, updates: Partial<MaintenanceWindow>) => {
    setSuppressionRules(prev => ({
      ...prev,
      maintenanceWindows: prev.maintenanceWindows.map(window =>
        window.id === id ? { ...window, ...updates } : window
      )
    }));
  };

  const handleAddMaintenanceWindow = () => {
    setSuppressionRules(prev => ({
      ...prev,
      maintenanceWindows: [
        ...prev.maintenanceWindows,
        {
          id: makeId(),
          name: 'Maintenance window',
          startsAt: '',
          endsAt: '',
          timezone: 'UTC'
        }
      ]
    }));
  };

  const handleRemoveMaintenanceWindow = (id: string) => {
    setSuppressionRules(prev => ({
      ...prev,
      maintenanceWindows: prev.maintenanceWindows.filter(window => window.id !== id)
    }));
  };

  const handleTargetTypeChange = (type: TargetScopeType) => {
    setTargetScope(prev => ({
      ...prev,
      type
    }));
  };

  const handleTargetToggle = (id: string) => {
    const key = targetKeyByType[targetScope.type];
    setTargetScope(prev => {
      const current = prev[key];
      const next = current.includes(id)
        ? current.filter(item => item !== id)
        : [...current, id];
      return {
        ...prev,
        [key]: next
      };
    });
  };

  const handleSave = async () => {
    if (!templateId) {
      setError('Missing alert template id.');
      return;
    }

    if (!name.trim()) {
      setError('Template name is required.');
      return;
    }

    setSaving(true);
    setError(undefined);

    try {
      const payload = {
        name: name.trim(),
        description: description.trim(),
        category,
        severity,
        conditions: {
          triggers: stripConditionIds(conditions),
          thresholdDefaults,
          notifications: notificationRouting,
          escalationRules: stripEscalationIds(escalationRules),
          autoRemediation,
          suppression: suppressionRules
        },
        targets: {
          scope: targetScope.type,
          orgIds: targetScope.orgIds,
          siteIds: targetScope.siteIds,
          groupIds: targetScope.groupIds
        },
        defaultCooldownMinutes: suppressionRules.suppressDuplicates
          ? suppressionRules.duplicateSuppressionMinutes
          : 0
      };

      const response = await fetch(`/api/alert-templates/${templateId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to save alert template.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto" />
          <p className="mt-4 text-sm text-muted-foreground">Loading alert template...</p>
        </div>
      </div>
    );
  }

  if (error && !hasLoaded) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={loadTemplate}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold">Alert Template Editor</h1>
          <p className="text-muted-foreground">Configure trigger logic, routing, and automation responses.</p>
        </div>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-60"
        >
          <Save className="h-4 w-4" />
          {saving ? 'Saving...' : 'Save template'}
        </button>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <div className="space-y-6">
          <div className="rounded-lg border bg-card p-6 shadow-sm">
            <h2 className="text-sm font-semibold">Template metadata</h2>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <label className="text-xs font-medium uppercase text-muted-foreground">Name</label>
                <input
                  value={name}
                  onChange={event => setName(event.target.value)}
                  className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
              <div>
                <label className="text-xs font-medium uppercase text-muted-foreground">Severity</label>
                <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
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
              <div>
                <label className="text-xs font-medium uppercase text-muted-foreground">Category</label>
                <select
                  value={category}
                  onChange={event => setCategory(event.target.value)}
                  className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  {categoryOptions.map(option => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </div>
              <div className="sm:col-span-2">
                <label className="text-xs font-medium uppercase text-muted-foreground">Description</label>
                <textarea
                  value={description}
                  onChange={event => setDescription(event.target.value)}
                  rows={3}
                  className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
            </div>
          </div>

          <div className="rounded-lg border bg-card p-6 shadow-sm">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold">Condition builder</h2>
                <p className="text-xs text-muted-foreground">
                  Combine metric thresholds with event patterns to trigger alerts.
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => handleAddCondition('metric')}
                  className="inline-flex h-8 items-center gap-2 rounded-md border px-3 text-xs font-medium hover:bg-muted"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Add metric
                </button>
                <button
                  type="button"
                  onClick={() => handleAddCondition('event')}
                  className="inline-flex h-8 items-center gap-2 rounded-md border px-3 text-xs font-medium hover:bg-muted"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Add event
                </button>
              </div>
            </div>

            <div className="mt-4 space-y-4">
              {conditions.map((condition, index) => (
                <div key={condition.id} className="rounded-md border bg-muted/30 p-4">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold uppercase text-muted-foreground">
                      Trigger {index + 1}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleRemoveCondition(condition.id)}
                      className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs font-medium text-destructive hover:bg-destructive/10"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      Remove
                    </button>
                  </div>

                  <div className="mt-4 grid gap-4 sm:grid-cols-2">
                    <div>
                      <label className="text-xs font-medium uppercase text-muted-foreground">Type</label>
                      <select
                        value={condition.type}
                        onChange={event =>
                          handleConditionTypeChange(condition.id, event.target.value as AlertCondition['type'])
                        }
                        className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                      >
                        <option value="metric">Metric threshold</option>
                        <option value="event">Event pattern</option>
                      </select>
                    </div>

                    {condition.type === 'metric' ? (
                      <>
                        <div>
                          <label className="text-xs font-medium uppercase text-muted-foreground">Metric</label>
                          <select
                            value={condition.metric}
                            onChange={event =>
                              handleConditionUpdate(condition.id, {
                                metric: event.target.value as MetricOption
                              })
                            }
                            className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                          >
                            {metricOptions.map(option => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="text-xs font-medium uppercase text-muted-foreground">Operator</label>
                          <select
                            value={condition.operator}
                            onChange={event =>
                              handleConditionUpdate(condition.id, {
                                operator: event.target.value as OperatorOption
                              })
                            }
                            className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                          >
                            {operatorOptions.map(option => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="text-xs font-medium uppercase text-muted-foreground">Threshold value</label>
                          <input
                            type="number"
                            value={condition.threshold}
                            onChange={event =>
                              handleConditionUpdate(condition.id, {
                                threshold: Number(event.target.value)
                              })
                            }
                            className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                          />
                        </div>
                        <div>
                          <label className="text-xs font-medium uppercase text-muted-foreground">Duration (min)</label>
                          <input
                            type="number"
                            value={condition.durationMinutes}
                            onChange={event =>
                              handleConditionUpdate(condition.id, {
                                durationMinutes: Number(event.target.value)
                              })
                            }
                            className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                          />
                        </div>
                        <div>
                          <label className="text-xs font-medium uppercase text-muted-foreground">Frequency count</label>
                          <input
                            type="number"
                            value={condition.occurrences}
                            onChange={event =>
                              handleConditionUpdate(condition.id, {
                                occurrences: Number(event.target.value)
                              })
                            }
                            className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                          />
                        </div>
                      </>
                    ) : (
                      <>
                        <div>
                          <label className="text-xs font-medium uppercase text-muted-foreground">Event source</label>
                          <select
                            value={condition.eventSource}
                            onChange={event =>
                              handleConditionUpdate(condition.id, {
                                eventSource: event.target.value as EventSourceOption
                              })
                            }
                            className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                          >
                            {eventSourceOptions.map(option => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="sm:col-span-2">
                          <label className="text-xs font-medium uppercase text-muted-foreground">Pattern</label>
                          <input
                            value={condition.pattern}
                            onChange={event =>
                              handleConditionUpdate(condition.id, {
                                pattern: event.target.value
                              })
                            }
                            className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                          />
                        </div>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-lg border bg-card p-6 shadow-sm">
            <h2 className="text-sm font-semibold">Threshold configuration</h2>
            <p className="mt-2 text-xs text-muted-foreground">
              Defaults used when adding new metric triggers. Adjust per trigger as needed.
            </p>
            <div className="mt-4 grid gap-4 sm:grid-cols-3">
              <div>
                <label className="text-xs font-medium uppercase text-muted-foreground">Default value</label>
                <input
                  type="number"
                  value={thresholdDefaults.value}
                  onChange={event =>
                    setThresholdDefaults(prev => ({
                      ...prev,
                      value: Number(event.target.value)
                    }))
                  }
                  className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
              <div>
                <label className="text-xs font-medium uppercase text-muted-foreground">Default duration (min)</label>
                <input
                  type="number"
                  value={thresholdDefaults.durationMinutes}
                  onChange={event =>
                    setThresholdDefaults(prev => ({
                      ...prev,
                      durationMinutes: Number(event.target.value)
                    }))
                  }
                  className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
              <div>
                <label className="text-xs font-medium uppercase text-muted-foreground">Default frequency count</label>
                <input
                  type="number"
                  value={thresholdDefaults.occurrences}
                  onChange={event =>
                    setThresholdDefaults(prev => ({
                      ...prev,
                      occurrences: Number(event.target.value)
                    }))
                  }
                  className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
            </div>
          </div>

          <div className="rounded-lg border bg-card p-6 shadow-sm">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold">Escalation rules</h2>
                <p className="text-xs text-muted-foreground">Route alerts based on time and severity.</p>
              </div>
              <button
                type="button"
                onClick={handleAddEscalation}
                className="inline-flex h-8 items-center gap-2 rounded-md border px-3 text-xs font-medium hover:bg-muted"
              >
                <Plus className="h-3.5 w-3.5" />
                Add escalation
              </button>
            </div>

            <div className="mt-4 space-y-3">
              {escalationRules.map((rule, index) => (
                <div key={rule.id} className="rounded-md border bg-muted/30 p-4">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold uppercase text-muted-foreground">
                      Step {index + 1}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleRemoveEscalation(rule.id)}
                      className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs font-medium text-destructive hover:bg-destructive/10"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      Remove
                    </button>
                  </div>
                  <div className="mt-3 grid gap-4 sm:grid-cols-3">
                    <div>
                      <label className="text-xs font-medium uppercase text-muted-foreground">After (min)</label>
                      <input
                        type="number"
                        value={rule.afterMinutes}
                        onChange={event =>
                          handleEscalationUpdate(rule.id, {
                            afterMinutes: Number(event.target.value)
                          })
                        }
                        className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium uppercase text-muted-foreground">Severity</label>
                      <select
                        value={rule.severity}
                        onChange={event =>
                          handleEscalationUpdate(rule.id, {
                            severity: event.target.value as AlertSeverity
                          })
                        }
                        className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                      >
                        {severityOptions.map(option => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="text-xs font-medium uppercase text-muted-foreground">Route</label>
                      <select
                        value={rule.route}
                        onChange={event =>
                          handleEscalationUpdate(rule.id, {
                            route: event.target.value as NotificationRoute
                          })
                        }
                        className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                      >
                        {escalationRoutes.map(option => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-lg border bg-card p-6 shadow-sm">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold">Suppression rules</h2>
                <p className="text-xs text-muted-foreground">Avoid noise during maintenance and duplicates.</p>
              </div>
              <button
                type="button"
                onClick={handleAddMaintenanceWindow}
                className="inline-flex h-8 items-center gap-2 rounded-md border px-3 text-xs font-medium hover:bg-muted"
              >
                <Plus className="h-3.5 w-3.5" />
                Add window
              </button>
            </div>

            <div className="mt-4 space-y-4">
              <label className="flex items-center justify-between gap-3 rounded-md border bg-background px-3 py-2 text-sm">
                <span>Suppress duplicate alerts</span>
                <input
                  type="checkbox"
                  checked={suppressionRules.suppressDuplicates}
                  onChange={event =>
                    setSuppressionRules(prev => ({
                      ...prev,
                      suppressDuplicates: event.target.checked
                    }))
                  }
                  className="h-4 w-4"
                />
              </label>

              {suppressionRules.suppressDuplicates && (
                <div>
                  <label className="text-xs font-medium uppercase text-muted-foreground">Cooldown minutes</label>
                  <input
                    type="number"
                    value={suppressionRules.duplicateSuppressionMinutes}
                    onChange={event =>
                      setSuppressionRules(prev => ({
                        ...prev,
                        duplicateSuppressionMinutes: Number(event.target.value)
                      }))
                    }
                    className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
              )}

              <div className="space-y-3">
                {suppressionRules.maintenanceWindows.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No maintenance windows configured. Add one to silence alerts during planned work.
                  </p>
                ) : (
                  suppressionRules.maintenanceWindows.map(window => (
                    <div key={window.id} className="rounded-md border bg-muted/30 p-3">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold uppercase text-muted-foreground">
                          {window.name}
                        </span>
                        <button
                          type="button"
                          onClick={() => handleRemoveMaintenanceWindow(window.id)}
                          className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium text-destructive hover:bg-destructive/10"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          Remove
                        </button>
                      </div>
                      <div className="mt-3 grid gap-3 sm:grid-cols-2">
                        <div>
                          <label className="text-xs font-medium uppercase text-muted-foreground">Name</label>
                          <input
                            value={window.name}
                            onChange={event =>
                              handleMaintenanceUpdate(window.id, { name: event.target.value })
                            }
                            className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                          />
                        </div>
                        <div>
                          <label className="text-xs font-medium uppercase text-muted-foreground">Timezone</label>
                          <select
                            value={window.timezone}
                            onChange={event =>
                              handleMaintenanceUpdate(window.id, { timezone: event.target.value })
                            }
                            className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                          >
                            {timezones.map(zone => (
                              <option key={zone} value={zone}>
                                {zone}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="text-xs font-medium uppercase text-muted-foreground">Starts</label>
                          <input
                            type="datetime-local"
                            value={window.startsAt}
                            onChange={event =>
                              handleMaintenanceUpdate(window.id, { startsAt: event.target.value })
                            }
                            className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                          />
                        </div>
                        <div>
                          <label className="text-xs font-medium uppercase text-muted-foreground">Ends</label>
                          <input
                            type="datetime-local"
                            value={window.endsAt}
                            onChange={event =>
                              handleMaintenanceUpdate(window.id, { endsAt: event.target.value })
                            }
                            className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                          />
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="space-y-6">
          <div className="rounded-lg border bg-card p-6 shadow-sm">
            <h2 className="text-sm font-semibold">Notification routing</h2>
            <div className="mt-4 space-y-3">
              {notificationOptions.map(option => (
                <label
                  key={option.id}
                  className="flex items-center justify-between gap-4 rounded-md border bg-background px-3 py-2 text-sm"
                >
                  <div>
                    <p className="font-medium">{option.label}</p>
                    <p className="text-xs text-muted-foreground">{option.description}</p>
                  </div>
                  <input
                    type="checkbox"
                    checked={notificationRouting[option.id]}
                    onChange={() => handleRoutingToggle(option.id)}
                    className="h-4 w-4"
                  />
                </label>
              ))}
            </div>
          </div>

          <div className="rounded-lg border bg-card p-6 shadow-sm">
            <h2 className="text-sm font-semibold">Auto-remediation</h2>
            <p className="mt-2 text-xs text-muted-foreground">
              Link an automation playbook to run when this alert fires.
            </p>
            <label className="mt-4 flex items-center justify-between gap-3 rounded-md border bg-background px-3 py-2 text-sm">
              <span>Enable auto-remediation</span>
              <input
                type="checkbox"
                checked={autoRemediation.enabled}
                onChange={event =>
                  setAutoRemediation(prev => ({
                    ...prev,
                    enabled: event.target.checked
                  }))
                }
                className="h-4 w-4"
              />
            </label>
            {autoRemediation.enabled && (
              <div className="mt-4">
                <label className="text-xs font-medium uppercase text-muted-foreground">Automation</label>
                <select
                  value={autoRemediation.automationId}
                  onChange={event =>
                    setAutoRemediation(prev => ({
                      ...prev,
                      automationId: event.target.value
                    }))
                  }
                  className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="">Select automation</option>
                  {automations.map(automation => (
                    <option key={automation.id} value={automation.id}>
                      {automation.name}
                    </option>
                  ))}
                </select>
                {automations.length === 0 && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    No automations available. Create one in Automations to enable remediation.
                  </p>
                )}
              </div>
            )}
          </div>

          <div className="rounded-lg border bg-card p-6 shadow-sm">
            <h2 className="text-sm font-semibold">Target scope</h2>
            <p className="mt-2 text-xs text-muted-foreground">
              Apply this template to organizations, sites, or groups.
            </p>
            <div className="mt-4">
              <label className="text-xs font-medium uppercase text-muted-foreground">Scope type</label>
              <select
                value={targetScope.type}
                onChange={event => handleTargetTypeChange(event.target.value as TargetScopeType)}
                className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="organization">Organizations</option>
                <option value="site">Sites</option>
                <option value="group">Groups</option>
              </select>
            </div>
            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              {targetOptions.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No {targetScope.type} options available. This template will apply broadly.
                </p>
              ) : (
                targetOptions.map(option => (
                  <label
                    key={option.id}
                    className="flex items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm"
                  >
                    <input
                      type="checkbox"
                      checked={selectedTargetIds.includes(option.id)}
                      onChange={() => handleTargetToggle(option.id)}
                      className="h-4 w-4"
                    />
                    <span>{option.name}</span>
                  </label>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
