import { useMemo, useState } from 'react';
import { Pencil, Plus, Trash2, ToggleLeft, ToggleRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AlertSeverity } from './AlertList';

export type AlertRuleTargetType = 'org' | 'site' | 'group' | 'device' | 'all';

export type AlertRuleTarget = {
  type: AlertRuleTargetType;
  ids?: string[];
  names?: string[];
};

export type AlertRuleConditionType = 'metric' | 'status' | 'custom';
export type MetricType = 'cpu' | 'ram' | 'disk' | 'network';
export type ComparisonOperator = 'gt' | 'lt' | 'gte' | 'lte' | 'eq' | 'neq';

export type AlertRuleCondition = {
  type: AlertRuleConditionType;
  metric?: MetricType;
  operator?: ComparisonOperator;
  value?: number;
  duration?: number;
  field?: string;
  customCondition?: string;
};

export type AlertRuleStatus = 'active' | 'paused';

export type AlertRule = {
  id: string;
  name: string;
  description?: string;
  severity?: AlertSeverity;
  enabled?: boolean;
  targets?: AlertRuleTarget;
  conditions?: AlertRuleCondition[];
  notificationChannelIds?: string[];
  cooldownMinutes?: number;
  autoResolve?: boolean;
  createdAt?: string;
  updatedAt?: string;
  templateId?: string;
  templateName?: string;
  targetType?: AlertRuleTargetType;
  targetName?: string;
  status?: AlertRuleStatus;
  alertsTriggered?: number;
  lastTriggered?: string;
};

type AlertRuleListProps = {
  rules?: AlertRule[];
  onEdit?: (rule: AlertRule) => void;
  onDelete?: (rule: AlertRule) => void;
  onToggle?: (rule: AlertRule, enabled: boolean) => void;
  onCreate?: () => void;
  onTest?: (rule: AlertRule) => void;
};

const statusConfig: Record<AlertRuleStatus, { label: string; className: string }> = {
  active: { label: 'Active', className: 'bg-emerald-500/20 text-emerald-700 border-emerald-500/40' },
  paused: { label: 'Paused', className: 'bg-gray-500/20 text-gray-700 border-gray-500/40' }
};

function formatTargets(targets: AlertRuleTarget): string {
  switch (targets.type) {
    case 'org':
    case 'all':
      return 'All Devices';
    case 'site':
      return targets.names?.length
        ? `Sites: ${targets.names.slice(0, 2).join(', ')}${
            targets.names.length > 2 ? ` +${targets.names.length - 2}` : ''
          }`
        : 'Selected Sites';
    case 'group':
      return targets.names?.length
        ? `Groups: ${targets.names.slice(0, 2).join(', ')}${
            targets.names.length > 2 ? ` +${targets.names.length - 2}` : ''
          }`
        : 'Selected Groups';
    case 'device':
      return targets.names?.length
        ? `Devices: ${targets.names.slice(0, 2).join(', ')}${
            targets.names.length > 2 ? ` +${targets.names.length - 2}` : ''
          }`
        : 'Selected Devices';
    default:
      return 'Unknown';
  }
}

function getTargetType(rule: AlertRule): AlertRuleTargetType {
  const targetType = rule.targetType ?? rule.targets?.type ?? 'org';
  return targetType === 'all' ? 'org' : targetType;
}

function getTargetLabel(rule: AlertRule): string {
  if (rule.targetName && rule.targetType) {
    const label = rule.targetType === 'org' ? 'Org' : rule.targetType[0].toUpperCase() + rule.targetType.slice(1);
    return `${label}: ${rule.targetName}`;
  }

  if (rule.targets) {
    return formatTargets(rule.targets);
  }

  return 'All Devices';
}

function getStatus(rule: AlertRule): AlertRuleStatus {
  if (rule.status) return rule.status;
  return rule.enabled ? 'active' : 'paused';
}

export default function AlertRuleList({
  rules = [],
  onEdit,
  onDelete,
  onToggle,
  onCreate
}: AlertRuleListProps) {
  const [templateFilter, setTemplateFilter] = useState('all');
  const [targetFilter, setTargetFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');

  const data = rules;

  const templateOptions = useMemo(() => {
    const set = new Set<string>();
    data.forEach(rule => {
      if (rule.templateName) set.add(rule.templateName);
    });
    return Array.from(set);
  }, [data]);

  const filteredRules = useMemo(() => {
    return data.filter(rule => {
      const ruleStatus = getStatus(rule);
      const ruleTargetType = getTargetType(rule);
      const ruleTemplate = rule.templateName ?? 'Custom Template';

      const matchesTemplate = templateFilter === 'all' ? true : ruleTemplate === templateFilter;
      const matchesTarget = targetFilter === 'all' ? true : ruleTargetType === targetFilter;
      const matchesStatus = statusFilter === 'all' ? true : ruleStatus === statusFilter;

      return matchesTemplate && matchesTarget && matchesStatus;
    });
  }, [data, statusFilter, targetFilter, templateFilter]);

  const handleToggle = (rule: AlertRule) => {
    const nextStatus: AlertRuleStatus = getStatus(rule) === 'active' ? 'paused' : 'active';
    onToggle?.(rule, nextStatus === 'active');
  };

  const handleDelete = (rule: AlertRule) => {
    onDelete?.(rule);
  };

  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Alert Rules</h2>
          <p className="text-sm text-muted-foreground">
            {filteredRules.length} of {data.length} rules
          </p>
        </div>
        <button
          type="button"
          onClick={onCreate}
          className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90"
        >
          <Plus className="h-4 w-4" />
          Add rule
        </button>
      </div>

      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
        <select
          value={templateFilter}
          onChange={event => setTemplateFilter(event.target.value)}
          className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-48"
        >
          <option value="all">All templates</option>
          {templateOptions.map(template => (
            <option key={template} value={template}>
              {template}
            </option>
          ))}
        </select>
        <select
          value={targetFilter}
          onChange={event => setTargetFilter(event.target.value)}
          className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-40"
        >
          <option value="all">All targets</option>
          <option value="org">Org</option>
          <option value="site">Site</option>
          <option value="group">Group</option>
          <option value="device">Device</option>
        </select>
        <select
          value={statusFilter}
          onChange={event => setStatusFilter(event.target.value)}
          className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-36"
        >
          <option value="all">All status</option>
          <option value="active">Active</option>
          <option value="paused">Paused</option>
        </select>
      </div>

      <div className="mt-6 overflow-hidden rounded-md border">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Template</th>
              <th className="px-4 py-3">Target</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Alerts Triggered</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {filteredRules.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-sm text-muted-foreground">
                  No alert rules found. Adjust your filters to see results.
                </td>
              </tr>
            ) : (
              filteredRules.map(rule => {
                const status = getStatus(rule);
                const templateName = rule.templateName ?? 'Custom Template';

                return (
                  <tr key={rule.id} className="transition hover:bg-muted/40">
                    <td className="px-4 py-3">
                      <div>
                        <p className="text-sm font-medium">{rule.name}</p>
                        {rule.description && (
                          <p className="text-xs text-muted-foreground truncate max-w-xs">{rule.description}</p>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <p className="text-sm font-medium">{templateName}</p>
                      {rule.templateId && (
                        <p className="text-xs text-muted-foreground">Template ID: {rule.templateId}</p>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <p className="text-sm">{getTargetLabel(rule)}</p>
                      <p className="text-xs text-muted-foreground">Type: {getTargetType(rule)}</p>
                    </td>
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        onClick={() => handleToggle(rule)}
                        className={cn(
                          'flex items-center gap-2 rounded-md border px-2.5 py-1 text-xs font-medium transition',
                          statusConfig[status].className
                        )}
                      >
                        {status === 'active' ? (
                          <ToggleRight className="h-4 w-4" />
                        ) : (
                          <ToggleLeft className="h-4 w-4" />
                        )}
                        {statusConfig[status].label}
                      </button>
                    </td>
                    <td className="px-4 py-3">
                      <p className="text-sm font-medium">{rule.alertsTriggered ?? 0}</p>
                      {rule.lastTriggered && (
                        <p className="text-xs text-muted-foreground">Last: {rule.lastTriggered}</p>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => onEdit?.(rule)}
                          className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
                          title="Edit rule"
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(rule)}
                          className="flex h-8 w-8 items-center justify-center rounded-md text-destructive hover:bg-destructive/10"
                          title="Delete rule"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
