import { useMemo, useState } from 'react';
import { Search, ChevronLeft, ChevronRight, Play, Pencil, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';

const REFERENCE_DATE = new Date('2024-01-15T12:00:00.000Z');

export type ScriptLanguage = 'powershell' | 'bash' | 'python' | 'cmd';
export type OSType = 'windows' | 'macos' | 'linux';
export type ScriptStatus = 'active' | 'draft' | 'archived';

export type Script = {
  id: string;
  name: string;
  description?: string;
  language: ScriptLanguage;
  category: string;
  osTypes: OSType[];
  lastRun?: string;
  status?: ScriptStatus;
  createdAt: string;
  updatedAt: string;
};

type ScriptListProps = {
  scripts: Script[];
  categories?: string[];
  onRun?: (script: Script) => void;
  onEdit?: (script: Script) => void;
  onDelete?: (script: Script) => void;
  pageSize?: number;
  timezone?: string;
};

const languageConfig: Record<ScriptLanguage, { label: string; color: string; icon: string }> = {
  powershell: { label: 'PowerShell', color: 'bg-blue-500/20 text-blue-700 border-blue-500/40', icon: 'PS' },
  bash: { label: 'Bash', color: 'bg-green-500/20 text-green-700 border-green-500/40', icon: '$' },
  python: { label: 'Python', color: 'bg-yellow-500/20 text-yellow-700 border-yellow-500/40', icon: 'Py' },
  cmd: { label: 'CMD', color: 'bg-gray-500/20 text-gray-700 border-gray-500/40', icon: '>' }
};

const statusConfig: Record<ScriptStatus, { label: string; color: string }> = {
  active: { label: 'Active', color: 'bg-green-500/20 text-green-700 border-green-500/40' },
  draft: { label: 'Draft', color: 'bg-yellow-500/20 text-yellow-700 border-yellow-500/40' },
  archived: { label: 'Archived', color: 'bg-gray-500/20 text-gray-700 border-gray-500/40' }
};

const osLabels: Record<OSType, string> = {
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux'
};

function formatLastRun(dateString?: string, timezone?: string): string {
  if (!dateString) return 'Never';

  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;

  const now = REFERENCE_DATE;
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
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
  timezone
}: ScriptListProps) {
  const [query, setQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [languageFilter, setLanguageFilter] = useState<string>('all');
  const [osFilter, setOsFilter] = useState<string>('all');
  const [currentPage, setCurrentPage] = useState(1);

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

  const totalPages = Math.ceil(filteredScripts.length / pageSize);
  const startIndex = (currentPage - 1) * pageSize;
  const paginatedScripts = filteredScripts.slice(startIndex, startIndex + pageSize);

  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Scripts</h2>
          <p className="text-sm text-muted-foreground">
            {filteredScripts.length} of {scripts.length} scripts
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center flex-wrap">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              placeholder="Search scripts..."
              value={query}
              onChange={event => {
                setQuery(event.target.value);
                setCurrentPage(1);
              }}
              className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-56"
            />
          </div>
          <select
            value={categoryFilter}
            onChange={event => {
              setCategoryFilter(event.target.value);
              setCurrentPage(1);
            }}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-36"
          >
            <option value="all">All Categories</option>
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
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-36"
          >
            <option value="all">All Languages</option>
            <option value="powershell">PowerShell</option>
            <option value="bash">Bash</option>
            <option value="python">Python</option>
            <option value="cmd">CMD</option>
          </select>
          <select
            value={osFilter}
            onChange={event => {
              setOsFilter(event.target.value);
              setCurrentPage(1);
            }}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-32"
          >
            <option value="all">All OS</option>
            <option value="windows">Windows</option>
            <option value="macos">macOS</option>
            <option value="linux">Linux</option>
          </select>
        </div>
      </div>

      <div className="mt-6 overflow-hidden rounded-md border">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Language</th>
              <th className="px-4 py-3">Category</th>
              <th className="px-4 py-3">OS Types</th>
              <th className="px-4 py-3">Last Run</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {paginatedScripts.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-sm text-muted-foreground">
                  No scripts found. Try adjusting your search or filters.
                </td>
              </tr>
            ) : (
              paginatedScripts.map(script => (
                <tr
                  key={script.id}
                  className="transition hover:bg-muted/40"
                >
                  <td className="px-4 py-3">
                    <div>
                      <p className="text-sm font-medium">{script.name}</p>
                      {script.description && (
                        <p className="text-xs text-muted-foreground truncate max-w-xs">
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
                      {languageConfig[script.language].label}
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
                          {osLabels[os]}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sm text-muted-foreground">
                    {formatLastRun(script.lastRun, timezone)}
                  </td>
                  <td className="px-4 py-3">
                    {(() => {
                      const cfg = statusConfig[script.status ?? 'active'];
                      return (
                        <span className={cn(
                          'inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium',
                          cfg.color
                        )}>
                          {cfg.label}
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
                        className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
                        title="Run script"
                      >
                        <Play className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onEdit?.(script);
                        }}
                        className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
                        title="Edit script"
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
                        title="Delete script"
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
            Showing {startIndex + 1} to {Math.min(startIndex + pageSize, filteredScripts.length)} of {filteredScripts.length}
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
