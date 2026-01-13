import { useMemo, useState } from 'react';
import {
  Search,
  ChevronLeft,
  ChevronRight,
  Pencil,
  Trash2,
  Play,
  ToggleLeft,
  ToggleRight
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AlertSeverity } from './AlertList';

export type AlertRuleTargetType = 'all' | 'site' | 'group' | 'device';

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
  duration?: number; // in minutes
  field?: string;
  customCondition?: string;
};

export type AlertRule = {
  id: string;
  name: string;
  description?: string;
  severity: AlertSeverity;
  enabled: boolean;
  targets: AlertRuleTarget;
  conditions: AlertRuleCondition[];
  notificationChannelIds: string[];
  cooldownMinutes: number;
  autoResolve: boolean;
  createdAt: string;
  updatedAt: string;
};

type AlertRuleListProps = {
  rules: AlertRule[];
  onEdit?: (rule: AlertRule) => void;
  onDelete?: (rule: AlertRule) => void;
  onTest?: (rule: AlertRule) => void;
  onToggle?: (rule: AlertRule, enabled: boolean) => void;
  pageSize?: number;
};

const severityConfig: Record<AlertSeverity, { label: string; color: string }> = {
  critical: { label: 'Critical', color: 'bg-red-500/20 text-red-700 border-red-500/40' },
  high: { label: 'High', color: 'bg-orange-500/20 text-orange-700 border-orange-500/40' },
  medium: { label: 'Medium', color: 'bg-yellow-500/20 text-yellow-700 border-yellow-500/40' },
  low: { label: 'Low', color: 'bg-blue-500/20 text-blue-700 border-blue-500/40' },
  info: { label: 'Info', color: 'bg-gray-500/20 text-gray-700 border-gray-500/40' }
};

function formatTargets(targets: AlertRuleTarget): string {
  switch (targets.type) {
    case 'all':
      return 'All Devices';
    case 'site':
      return targets.names?.length
        ? `Sites: ${targets.names.slice(0, 2).join(', ')}${targets.names.length > 2 ? ` +${targets.names.length - 2}` : ''}`
        : 'Selected Sites';
    case 'group':
      return targets.names?.length
        ? `Groups: ${targets.names.slice(0, 2).join(', ')}${targets.names.length > 2 ? ` +${targets.names.length - 2}` : ''}`
        : 'Selected Groups';
    case 'device':
      return targets.names?.length
        ? `Devices: ${targets.names.slice(0, 2).join(', ')}${targets.names.length > 2 ? ` +${targets.names.length - 2}` : ''}`
        : 'Selected Devices';
    default:
      return 'Unknown';
  }
}

function formatConditions(conditions: AlertRuleCondition[]): string {
  return conditions
    .map(c => {
      if (c.type === 'metric' && c.metric) {
        const metricLabel = c.metric.toUpperCase();
        const op = c.operator === 'gt' ? '>' : c.operator === 'lt' ? '<' : c.operator === 'gte' ? '>=' : c.operator === 'lte' ? '<=' : '=';
        return `${metricLabel} ${op} ${c.value}%`;
      }
      if (c.type === 'status') {
        return `Offline for ${c.duration}m`;
      }
      if (c.type === 'custom' && c.field) {
        return `${c.field} condition`;
      }
      return 'Custom condition';
    })
    .join(', ');
}

export default function AlertRuleList({
  rules,
  onEdit,
  onDelete,
  onTest,
  onToggle,
  pageSize = 10
}: AlertRuleListProps) {
  const [query, setQuery] = useState('');
  const [severityFilter, setSeverityFilter] = useState<string>('all');
  const [enabledFilter, setEnabledFilter] = useState<string>('all');
  const [currentPage, setCurrentPage] = useState(1);

  const filteredRules = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return rules.filter(rule => {
      const matchesQuery =
        normalizedQuery.length === 0
          ? true
          : rule.name.toLowerCase().includes(normalizedQuery) ||
            rule.description?.toLowerCase().includes(normalizedQuery);
      const matchesSeverity = severityFilter === 'all' ? true : rule.severity === severityFilter;
      const matchesEnabled =
        enabledFilter === 'all'
          ? true
          : enabledFilter === 'enabled'
            ? rule.enabled
            : !rule.enabled;

      return matchesQuery && matchesSeverity && matchesEnabled;
    });
  }, [rules, query, severityFilter, enabledFilter]);

  const totalPages = Math.ceil(filteredRules.length / pageSize);
  const startIndex = (currentPage - 1) * pageSize;
  const paginatedRules = filteredRules.slice(startIndex, startIndex + pageSize);

  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Alert Rules</h2>
          <p className="text-sm text-muted-foreground">
            {filteredRules.length} of {rules.length} rules
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              placeholder="Search rules..."
              value={query}
              onChange={event => {
                setQuery(event.target.value);
                setCurrentPage(1);
              }}
              className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-48"
            />
          </div>
          <select
            value={severityFilter}
            onChange={event => {
              setSeverityFilter(event.target.value);
              setCurrentPage(1);
            }}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-32"
          >
            <option value="all">All Severity</option>
            <option value="critical">Critical</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
            <option value="info">Info</option>
          </select>
          <select
            value={enabledFilter}
            onChange={event => {
              setEnabledFilter(event.target.value);
              setCurrentPage(1);
            }}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-32"
          >
            <option value="all">All Status</option>
            <option value="enabled">Enabled</option>
            <option value="disabled">Disabled</option>
          </select>
        </div>
      </div>

      <div className="mt-6 overflow-hidden rounded-md border">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Severity</th>
              <th className="px-4 py-3">Targets</th>
              <th className="px-4 py-3">Conditions</th>
              <th className="px-4 py-3">Enabled</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {paginatedRules.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-sm text-muted-foreground">
                  No alert rules found. Try adjusting your search or filters.
                </td>
              </tr>
            ) : (
              paginatedRules.map(rule => (
                <tr key={rule.id} className="transition hover:bg-muted/40">
                  <td className="px-4 py-3">
                    <div>
                      <p className="text-sm font-medium">{rule.name}</p>
                      {rule.description && (
                        <p className="text-xs text-muted-foreground truncate max-w-xs">
                          {rule.description}
                        </p>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={cn(
                        'inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium',
                        severityConfig[rule.severity].color
                      )}
                    >
                      {severityConfig[rule.severity].label}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm">{formatTargets(rule.targets)}</td>
                  <td className="px-4 py-3">
                    <p className="text-sm text-muted-foreground truncate max-w-xs">
                      {formatConditions(rule.conditions)}
                    </p>
                  </td>
                  <td className="px-4 py-3">
                    <button
                      type="button"
                      onClick={() => onToggle?.(rule, !rule.enabled)}
                      className={cn(
                        'flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition',
                        rule.enabled
                          ? 'bg-green-500/20 text-green-700 hover:bg-green-500/30'
                          : 'bg-gray-500/20 text-gray-700 hover:bg-gray-500/30'
                      )}
                    >
                      {rule.enabled ? (
                        <>
                          <ToggleRight className="h-4 w-4" />
                          On
                        </>
                      ) : (
                        <>
                          <ToggleLeft className="h-4 w-4" />
                          Off
                        </>
                      )}
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        type="button"
                        onClick={() => onTest?.(rule)}
                        className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
                        title="Test rule"
                      >
                        <Play className="h-4 w-4" />
                      </button>
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
                        onClick={() => onDelete?.(rule)}
                        className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted text-destructive"
                        title="Delete rule"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Showing {startIndex + 1} to {Math.min(startIndex + pageSize, filteredRules.length)} of{' '}
            {filteredRules.length}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
              disabled={currentPage === 1}
              className="flex h-9 w-9 items-center justify-center rounded-md border hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="text-sm">
              Page {currentPage} of {totalPages}
            </span>
            <button
              type="button"
              onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
              disabled={currentPage === totalPages}
              className="flex h-9 w-9 items-center justify-center rounded-md border hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
