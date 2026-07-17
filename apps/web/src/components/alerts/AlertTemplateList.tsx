import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../../lib/i18n';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { useOrgStore } from '@/stores/orgStore';
import { runAction, handleActionError, ActionError } from '../../lib/runAction';
import { ScopeBadge } from '../shared/ScopeBadge';
import type { AlertSeverity } from './AlertList';

// Raw row shape returned by GET /alert-templates/templates (the scope-aware CRUD
// route). Partner-wide rows have orgId === null && partnerId !== null; built-in
// rows have isBuiltIn === true.
type AlertTemplate = {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  severity: AlertSeverity;
  orgId: string | null;
  partnerId: string | null;
  isBuiltIn: boolean;
  autoResolve: boolean;
};

const UNAUTHORIZED = () => void navigateTo('/login', { replace: true });

const severityStyles: Record<AlertSeverity, { label: string; className: string }> = {
  critical: { label: 'Critical', className: 'bg-red-500/20 text-red-700 border-red-500/40' },
  high: { label: 'High', className: 'bg-orange-500/20 text-orange-700 border-orange-500/40' },
  medium: { label: 'Medium', className: 'bg-yellow-500/20 text-yellow-700 border-yellow-500/40' },
  low: { label: 'Low', className: 'bg-blue-500/20 text-blue-700 border-blue-500/40' },
  info: { label: 'Info', className: 'bg-gray-500/20 text-gray-700 border-gray-500/40' }
};

export default function AlertTemplateList() {
  const { t } = useTranslation('alerts');
  const { organizations } = useOrgStore();
  const [templates, setTemplates] = useState<AlertTemplate[]>([]);
  const [severityFilter, setSeverityFilter] = useState('all');
  const [scopeFilter, setScopeFilter] = useState('all');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchTemplates = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetchWithAuth('/alert-templates/templates?limit=200');
      if (response.status === 401) return UNAUTHORIZED();
      if (!response.ok) throw new Error('Failed to fetch templates');
      const body = (await response.json()) as { data: AlertTemplate[] };
      setTemplates(body.data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load templates');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { void fetchTemplates(); }, [fetchTemplates]);

  const handleDelete = async (template: AlertTemplate) => {
    if (template.isBuiltIn) return;
    if (!window.confirm(t('alertTemplateList.deleteConfirm', { name: template.name }))) return;
    try {
      await runAction({
        request: () => fetchWithAuth(`/alert-templates/templates/${template.id}`, { method: 'DELETE' }),
        errorFallback: t('alertTemplateList.deleteFailed'),
        successMessage: t('alertTemplateList.deleted'),
        onUnauthorized: UNAUTHORIZED,
      });
      void fetchTemplates();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      handleActionError(err, t('alertTemplateList.deleteFailed'));
    }
  };

  const orgNameFor = useCallback(
    (orgId: string | null) => organizations.find(o => o.id === orgId)?.name,
    [organizations],
  );

  const filteredTemplates = useMemo(() => {
    return templates.filter(template => {
      const matchesSeverity = severityFilter === 'all' ? true : template.severity === severityFilter;
      const scope = template.isBuiltIn
        ? 'built-in'
        : template.orgId === null && template.partnerId !== null
          ? 'partner'
          : 'org';
      const matchesScope = scopeFilter === 'all' ? true : scope === scopeFilter;
      return matchesSeverity && matchesScope;
    });
  }, [templates, severityFilter, scopeFilter]);

  if (isLoading) {
    return (
      <div className="rounded-lg border bg-card p-6 shadow-xs">
        <div className="flex h-48 items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border bg-card p-6 shadow-xs">
        <div className="flex h-48 flex-col items-center justify-center gap-2 text-muted-foreground" data-testid="alert-template-list-error">
          <p>{error}</p>
          <button type="button" onClick={() => void fetchTemplates()} className="text-sm text-primary hover:underline">
            {t('alertTemplateList.tryAgain')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-card p-6 shadow-xs" data-testid="alert-template-list">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-lg font-semibold">{t('alertTemplateList.alertTemplates')}</h2>
          </div>
          <p className="text-sm text-muted-foreground">
            {filteredTemplates.length} {t('alertTemplateList.of')} {templates.length} {t('alertTemplateList.templates')}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void navigateTo('/settings/alert-templates/new')}
          data-testid="alert-template-create"
          className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90"
        >
          <Plus className="h-4 w-4" />
          {t('alertTemplateList.addTemplate')}
        </button>
      </div>

      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
        <select
          value={severityFilter}
          onChange={event => setSeverityFilter(event.target.value)}
          className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring sm:w-40"
        >
          <option value="all">{t('alertTemplateList.allSeverity')}</option>
          <option value="critical">{t('alertTemplateList.critical')}</option>
          <option value="high">{t('alertTemplateList.high')}</option>
          <option value="medium">{t('alertTemplateList.medium')}</option>
          <option value="low">{t('alertTemplateList.low')}</option>
          <option value="info">{t('alertTemplateList.info')}</option>
        </select>
        <select
          value={scopeFilter}
          onChange={event => setScopeFilter(event.target.value)}
          data-testid="alert-template-scope-filter"
          className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring sm:w-44"
        >
          <option value="all">{t('alertTemplateList.allScopes')}</option>
          <option value="partner">{t('alertTemplateList.partnerWide')}</option>
          <option value="org">{t('alertTemplateList.organization')}</option>
          <option value="built-in">{t('alertTemplateList.builtIn')}</option>
        </select>
      </div>

      <div className="mt-6 overflow-x-auto rounded-md border">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3">{t('alertTemplateList.name')}</th>
              <th className="px-4 py-3">{t('alertTemplateList.scope')}</th>
              <th className="px-4 py-3">{t('alertTemplateList.severity')}</th>
              <th className="px-4 py-3">{t('alertTemplateList.category')}</th>
              <th className="px-4 py-3 text-right">{t('alertTemplateList.actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {filteredTemplates.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-sm text-muted-foreground">
                  {t('alertTemplateList.noTemplatesMatchYourFilters')}
                </td>
              </tr>
            ) : (
              filteredTemplates.map(template => (
                <tr key={template.id} className="transition hover:bg-muted/40" data-testid={`alert-template-row-${template.id}`}>
                  <td className="px-4 py-3">
                    <p className="text-sm font-medium">{template.name}</p>
                    {template.description && (
                      <p className="text-xs text-muted-foreground truncate max-w-xs">{template.description}</p>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <ScopeBadge
                      orgId={template.orgId}
                      partnerId={template.partnerId}
                      isSystem={template.isBuiltIn}
                      orgName={orgNameFor(template.orgId)}
                    />
                  </td>
                  <td className="px-4 py-3">
                    <span className={cn('inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium', severityStyles[template.severity].className)}>
                      {severityStyles[template.severity].label}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm text-muted-foreground">{template.category ?? '—'}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        type="button"
                        onClick={() => void navigateTo(`/settings/alert-templates/${template.id}`)}
                        data-testid={`alert-template-edit-${template.id}`}
                        className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
                        title={template.isBuiltIn ? 'View template' : 'Edit template'}
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDelete(template)}
                        disabled={template.isBuiltIn}
                        data-testid={`alert-template-delete-${template.id}`}
                        className={cn(
                          'flex h-8 w-8 items-center justify-center rounded-md text-destructive transition',
                          template.isBuiltIn ? 'cursor-not-allowed opacity-40' : 'hover:bg-destructive/10'
                        )}
                        title={template.isBuiltIn ? 'Built-in templates cannot be deleted' : 'Delete template'}
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
