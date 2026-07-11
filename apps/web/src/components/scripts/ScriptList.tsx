import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Search, ChevronLeft, ChevronRight, ChevronUp, ChevronDown, Play, Pencil, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ScriptLanguage, OSType, ScriptRunAs } from '@breeze/shared';
import { ScopeBadge } from '../shared/ScopeBadge';
export type { ScriptLanguage, OSType } from '@breeze/shared';
export type ScriptStatus = 'active' | 'draft' | 'archived';
type ScriptsT = TFunction<'scripts'>;

export type Script = {
  id: string;
  name: string;
  description?: string;
  language: ScriptLanguage;
  category: string;
  osTypes: OSType[];
  runAs?: ScriptRunAs;
  lastRun?: string;
  status?: ScriptStatus;
  createdAt: string;
  updatedAt: string;
  // Scope fields — present when the API returns them (after org-scope-normalization).
  orgId?: string | null;
  partnerId?: string | null;
  isSystem?: boolean;
};

type Organization = {
  id: string;
  name: string;
};

type ScriptListProps = {
  scripts: Script[];
  categories?: string[];
  onRun?: (script: Script) => void;
  onEdit?: (script: Script) => void;
  onDelete?: (script: Script) => void;
  pageSize?: number;
  timezone?: string;
  organizations?: Organization[];
};

const languageConfig: Record<ScriptLanguage, { label: string; color: string; icon: string }> = {
  powershell: { label: 'languages.powershell', color: 'bg-blue-500/20 text-blue-700 border-blue-500/40', icon: 'PS' },
  bash: { label: 'languages.bash', color: 'bg-green-500/20 text-green-700 border-green-500/40', icon: '$' },
  python: { label: 'languages.python', color: 'bg-yellow-500/20 text-yellow-700 border-yellow-500/40', icon: 'Py' },
  cmd: { label: 'languages.cmd', color: 'bg-gray-500/20 text-gray-700 border-gray-500/40', icon: '>' }
};

const statusConfig: Record<ScriptStatus, { label: string; color: string }> = {
  active: { label: 'status.active', color: 'bg-success/15 text-success border-success/30' },
  draft: { label: 'status.draft', color: 'bg-warning/15 text-warning border-warning/30' },
  archived: { label: 'status.archived', color: 'bg-muted text-muted-foreground border-border' }
};

const osLabels: Record<OSType, string> = {
  windows: 'os.windows',
  macos: 'os.macos',
  linux: 'os.linux'
};

function formatLastRun(dateString: string | undefined, t: ScriptsT, timezone?: string): string {
  if (!dateString) return t('scriptList.never');

  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;

  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMins < 1) return t('scriptList.relativeTime.justNow');
  if (diffMins < 60) return t('scriptList.relativeTime.minutesAgo', { count: diffMins });
  if (diffHours < 24) return t('scriptList.relativeTime.hoursAgo', { count: diffHours });
  if (diffDays < 7) return t('scriptList.relativeTime.daysAgo', { count: diffDays });
  const tz = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  return date.toLocaleDateString(undefined, { timeZone: tz });
}

export default function ScriptList({
  scripts,
  categories = [],
  onRun,
  onEdit,
  onDelete,
  pageSize = 10,
  timezone,
  organizations = [],
}: ScriptListProps) {
  const { t } = useTranslation('scripts');
  const [query, setQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [languageFilter, setLanguageFilter] = useState<string>('all');
  const [osFilter, setOsFilter] = useState<string>('all');
  const [currentPage, setCurrentPage] = useState(1);
  const [sortColumn, setSortColumn] = useState<string | null>(null);
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');

  const toggleSort = (column: string) => {
    if (sortColumn === column) {
      setSortDirection(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortColumn(column);
      setSortDirection('asc');
    }
    setCurrentPage(1);
  };

  // Extract unique categories from scripts if not provided
  const availableCategories = useMemo(() => {
    if (categories.length > 0) return categories;
    const cats = new Set(scripts.map(s => s.category));
    return Array.from(cats).sort();
  }, [scripts, categories]);

  const filteredScripts = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return scripts.filter(script => {
      const matchesQuery = normalizedQuery.length === 0
        ? true
        : script.name.toLowerCase().includes(normalizedQuery) ||
          script.description?.toLowerCase().includes(normalizedQuery);
      const matchesCategory = categoryFilter === 'all' ? true : script.category === categoryFilter;
      const matchesLanguage = languageFilter === 'all' ? true : script.language === languageFilter;
      const matchesOs = osFilter === 'all' ? true : script.osTypes.includes(osFilter as OSType);

      return matchesQuery && matchesCategory && matchesLanguage && matchesOs;
    });
  }, [scripts, query, categoryFilter, languageFilter, osFilter]);

  const sortedScripts = useMemo(() => {
    if (!sortColumn) return filteredScripts;
    return [...filteredScripts].sort((a, b) => {
      let cmp = 0;
      switch (sortColumn) {
        case 'name':
          cmp = a.name.localeCompare(b.name);
          break;
        case 'language':
          cmp = a.language.localeCompare(b.language);
          break;
        case 'category':
          cmp = a.category.localeCompare(b.category);
          break;
        case 'lastRun':
          cmp = (a.lastRun ?? '').localeCompare(b.lastRun ?? '');
          break;
        case 'status':
          cmp = (a.status ?? 'active').localeCompare(b.status ?? 'active');
          break;
      }
      return sortDirection === 'asc' ? cmp : -cmp;
    });
  }, [filteredScripts, sortColumn, sortDirection]);

  const totalPages = Math.ceil(sortedScripts.length / pageSize);
  const startIndex = (currentPage - 1) * pageSize;
  const paginatedScripts = sortedScripts.slice(startIndex, startIndex + pageSize);

  return (
    <div className="rounded-lg border bg-card p-6 shadow-xs">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex flex-1 flex-col gap-2 sm:flex-row sm:items-center flex-wrap">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              placeholder={t('scriptList.searchPlaceholder')}
              value={query}
              onChange={event => {
                setQuery(event.target.value);
                setCurrentPage(1);
              }}
              className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring sm:w-56"
            />
          </div>
          <select
            value={categoryFilter}
            onChange={event => {
              setCategoryFilter(event.target.value);
              setCurrentPage(1);
            }}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring sm:w-36"
          >
            <option value="all">{t('scriptList.filters.allCategories')}</option>
            {availableCategories.map(cat => (
              <option key={cat} value={cat}>
                {cat}
              </option>
            ))}
          </select>
          <select
            value={languageFilter}
            onChange={event => {
              setLanguageFilter(event.target.value);
              setCurrentPage(1);
            }}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring sm:w-36"
          >
            <option value="all">{t('scriptList.filters.allLanguages')}</option>
            <option value="powershell">{t('scriptList.languages.powershell')}</option>
            <option value="bash">{t('scriptList.languages.bash')}</option>
            <option value="python">{t('scriptList.languages.python')}</option>
            <option value="cmd">{t('scriptList.languages.cmd')}</option>
          </select>
          <select
            value={osFilter}
            onChange={event => {
              setOsFilter(event.target.value);
              setCurrentPage(1);
            }}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring sm:w-32"
          >
            <option value="all">{t('scriptList.filters.allOs')}</option>
            <option value="windows">{t('scriptList.os.windows')}</option>
            <option value="macos">{t('scriptList.os.macos')}</option>
            <option value="linux">{t('scriptList.os.linux')}</option>
          </select>
        </div>
        <span className="text-xs text-muted-foreground tabular-nums whitespace-nowrap">
          {t('scriptList.summary', { shown: filteredScripts.length, total: scripts.length })}
        </span>
      </div>

      <div className="mt-4 overflow-x-auto rounded-md border">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-2.5 cursor-pointer select-none transition-colors hover:text-foreground" onClick={() => toggleSort('name')}>
                <span className="inline-flex items-center gap-1">
                  {t('common:labels.name')}
                  {sortColumn === 'name' && (sortDirection === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />)}
                </span>
              </th>
              <th className="px-4 py-2.5 cursor-pointer select-none transition-colors hover:text-foreground" onClick={() => toggleSort('language')}>
                <span className="inline-flex items-center gap-1">
                  {t('scriptList.headers.language')}
                  {sortColumn === 'language' && (sortDirection === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />)}
                </span>
              </th>
              <th className="px-4 py-2.5 cursor-pointer select-none transition-colors hover:text-foreground" onClick={() => toggleSort('category')}>
                <span className="inline-flex items-center gap-1">
                  {t('scriptList.headers.category')}
                  {sortColumn === 'category' && (sortDirection === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />)}
                </span>
              </th>
              <th className="px-4 py-2.5">{t('scriptList.headers.os')}</th>
              <th className="px-4 py-2.5 cursor-pointer select-none transition-colors hover:text-foreground" onClick={() => toggleSort('lastRun')}>
                <span className="inline-flex items-center gap-1">
                  {t('scriptList.headers.lastRun')}
                  {sortColumn === 'lastRun' && (sortDirection === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />)}
                </span>
              </th>
              <th className="px-4 py-2.5 cursor-pointer select-none transition-colors hover:text-foreground" onClick={() => toggleSort('status')}>
                <span className="inline-flex items-center gap-1">
                  {t('common:labels.status')}
                  {sortColumn === 'status' && (sortDirection === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />)}
                </span>
              </th>
              <th className="px-4 py-2.5 text-right">{t('common:labels.actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {paginatedScripts.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-sm text-muted-foreground">
                  {t('scriptList.empty')}
                </td>
              </tr>
            ) : (
              paginatedScripts.map(script => (
                <tr
                  key={script.id}
                  tabIndex={0}
                  role="button"
                  className="transition hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-hidden"
                  onClick={() => onEdit?.(script)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); onEdit?.(script); }
                    if (e.key === ' ') { e.preventDefault(); onRun?.(script); }
                  }}
                >
                  <td className="max-w-[280px] px-4 py-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <p className="truncate text-sm font-medium" title={script.name}>{script.name}</p>
                        {(script.isSystem !== undefined || script.partnerId !== undefined || script.orgId !== undefined) && (
                          <ScopeBadge
                            orgId={script.orgId ?? null}
                            partnerId={script.partnerId ?? null}
                            isSystem={script.isSystem ?? false}
                            orgName={organizations.find(o => o.id === script.orgId)?.name}
                          />
                        )}
                      </div>
                      {script.description && (
                        <p className="text-xs text-muted-foreground truncate max-w-xs" title={script.description}>
                          {script.description}
                        </p>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className={cn(
                      'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium',
                      languageConfig[script.language].color
                    )}>
                      <span className="font-mono text-[10px]">{languageConfig[script.language].icon}</span>
                      {t(/* i18n-dynamic */ `scriptList.${languageConfig[script.language].label}`)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm">{script.category}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {script.osTypes.map(os => (
                        <span
                          key={os}
                          className="inline-flex items-center rounded bg-muted px-1.5 py-0.5 text-xs"
                        >
                          {t(/* i18n-dynamic */ `scriptList.${osLabels[os]}`)}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sm text-muted-foreground">
                    {formatLastRun(script.lastRun, t, timezone)}
                  </td>
                  <td className="px-4 py-3">
                    {(() => {
                      const cfg = statusConfig[script.status ?? 'active'];
                      return (
                        <span className={cn(
                          'inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium',
                          cfg.color
                        )}>
                          {t(/* i18n-dynamic */ `scriptList.${cfg.label}`)}
                        </span>
                      );
                    })()}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onRun?.(script);
                        }}
                        className="inline-flex h-7 items-center gap-1 rounded-md bg-primary/10 px-2 text-xs font-medium text-primary hover:bg-primary/20 transition-colors"
                        title={t('scriptList.actions.runTitle')}
                      >
                        <Play className="h-3 w-3" />
                        {t('common:actions.run')}
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onEdit?.(script);
                        }}
                        className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
                        title={t('scriptList.actions.editTitle')}
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onDelete?.(script);
                        }}
                        className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted text-destructive"
                        title={t('scriptList.actions.deleteTitle')}
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
            {t('scriptList.pagination.showing', {
              start: startIndex + 1,
              end: Math.min(startIndex + pageSize, filteredScripts.length),
              total: filteredScripts.length
            })}
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
              {t('scriptList.pagination.page', { page: currentPage, total: totalPages })}
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
