import { useCallback, useEffect, useMemo, useState } from 'react';
import { Copy, Pencil, Plus, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';
import type { AlertSeverity } from './AlertList';

type AlertTemplate = {
  id: string;
  name: string;
  description: string;
  severity: AlertSeverity;
  conditions: string[];
  autoResolve: boolean;
  usageCount: number;
  builtIn: boolean;
};

type AlertTemplateListProps = {
  onEdit?: (template: AlertTemplate) => void;
  onDuplicate?: (template: AlertTemplate) => void;
  onDelete?: (template: AlertTemplate) => void;
  onCreate?: () => void;
};

const severityStyles: Record<AlertSeverity, { label: string; className: string }> = {
  critical: { label: 'Critical', className: 'bg-red-500/20 text-red-700 border-red-500/40' },
  high: { label: 'High', className: 'bg-orange-500/20 text-orange-700 border-orange-500/40' },
  medium: { label: 'Medium', className: 'bg-yellow-500/20 text-yellow-700 border-yellow-500/40' },
  low: { label: 'Low', className: 'bg-blue-500/20 text-blue-700 border-blue-500/40' },
  info: { label: 'Info', className: 'bg-gray-500/20 text-gray-700 border-gray-500/40' }
};

export default function AlertTemplateList({
  onEdit,
  onDuplicate,
  onDelete,
  onCreate
}: AlertTemplateListProps) {
  const [templates, setTemplates] = useState<AlertTemplate[]>([]);
  const [severityFilter, setSeverityFilter] = useState('all');
  const [sourceFilter, setSourceFilter] = useState('all');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchTemplates = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const response = await fetchWithAuth('/alerts/templates');

      if (response.status === 401) {
        window.location.href = '/login';
        return;
      }

      if (!response.ok) {
        throw new Error('Failed to fetch templates');
      }

      const data = await response.json();
      setTemplates(data.templates || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load templates');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTemplates();
  }, [fetchTemplates]);

  const handleDelete = async (template: AlertTemplate) => {
    if (template.builtIn) return;

    try {
      const response = await fetchWithAuth(`/alerts/templates/${template.id}`, {
        method: 'DELETE'
      });

      if (response.status === 401) {
        window.location.href = '/login';
        return;
      }

      if (response.ok) {
        fetchTemplates();
        onDelete?.(template);
      }
    } catch {
      // Handle error silently or show notification
    }
  };

  const handleDuplicate = async (template: AlertTemplate) => {
    try {
      const response = await fetchWithAuth(`/alerts/templates/${template.id}/duplicate`, {
        method: 'POST'
      });

      if (response.status === 401) {
        window.location.href = '/login';
        return;
      }

      if (response.ok) {
        fetchTemplates();
        onDuplicate?.(template);
      }
    } catch {
      // Handle error silently or show notification
    }
  };

  const filteredTemplates = useMemo(() => {
    return templates.filter(template => {
      const matchesSeverity =
        severityFilter === 'all' ? true : template.severity === severityFilter;
      const matchesSource =
        sourceFilter === 'all'
          ? true
          : sourceFilter === 'built-in'
            ? template.builtIn
            : !template.builtIn;

      return matchesSeverity && matchesSource;
    });
  }, [templates, severityFilter, sourceFilter]);

  if (isLoading) {
    return (
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex h-48 items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex h-48 flex-col items-center justify-center gap-2 text-muted-foreground">
          <p>{error}</p>
          <button
            type="button"
            onClick={fetchTemplates}
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
          <h2 className="text-lg font-semibold">Alert Templates</h2>
          <p className="text-sm text-muted-foreground">
            {filteredTemplates.length} of {templates.length} templates
          </p>
        </div>
        <button
          type="button"
          onClick={onCreate}
          className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90"
        >
          <Plus className="h-4 w-4" />
          Add template
        </button>
      </div>

      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
        <select
          value={severityFilter}
          onChange={event => setSeverityFilter(event.target.value)}
          className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-40"
        >
          <option value="all">All severity</option>
          <option value="critical">Critical</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
          <option value="info">Info</option>
        </select>
        <select
          value={sourceFilter}
          onChange={event => setSourceFilter(event.target.value)}
          className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-40"
        >
          <option value="all">All sources</option>
          <option value="built-in">Built-in</option>
          <option value="custom">Custom</option>
        </select>
      </div>

      <div className="mt-6 overflow-hidden rounded-md border">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Severity</th>
              <th className="px-4 py-3">Conditions</th>
              <th className="px-4 py-3">Auto-resolve</th>
              <th className="px-4 py-3">Usage</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {filteredTemplates.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-sm text-muted-foreground">
                  No templates match your filters.
                </td>
              </tr>
            ) : (
              filteredTemplates.map(template => (
                <tr key={template.id} className="transition hover:bg-muted/40">
                  <td className="px-4 py-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium">{template.name}</p>
                        <span
                          className={cn(
                            'rounded-full border px-2 py-0.5 text-[11px] font-medium',
                            template.builtIn
                              ? 'border-emerald-500/40 bg-emerald-500/20 text-emerald-700'
                              : 'border-slate-500/40 bg-slate-500/20 text-slate-700'
                          )}
                        >
                          {template.builtIn ? 'Built-in' : 'Custom'}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground truncate max-w-xs">
                        {template.description}
                      </p>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={cn(
                        'inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium',
                        severityStyles[template.severity].className
                      )}
                    >
                      {severityStyles[template.severity].label}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <p className="text-sm text-muted-foreground truncate max-w-xs">
                      {template.conditions.join(' • ')}
                    </p>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={cn(
                        'inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium',
                        template.autoResolve
                          ? 'bg-emerald-500/20 text-emerald-700 border-emerald-500/40'
                          : 'bg-gray-500/20 text-gray-700 border-gray-500/40'
                      )}
                    >
                      {template.autoResolve ? 'Enabled' : 'Off'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm font-medium">{template.usageCount}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        type="button"
                        onClick={() => onEdit?.(template)}
                        className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
                        title="Edit template"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDuplicate(template)}
                        className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
                        title="Duplicate template"
                      >
                        <Copy className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(template)}
                        disabled={template.builtIn}
                        className={cn(
                          'flex h-8 w-8 items-center justify-center rounded-md text-destructive transition',
                          template.builtIn
                            ? 'cursor-not-allowed opacity-40'
                            : 'hover:bg-destructive/10'
                        )}
                        title={template.builtIn ? 'Built-in templates cannot be deleted' : 'Delete template'}
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
    </div>
  );
}
