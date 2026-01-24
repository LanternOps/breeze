import { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';

export type ScriptTemplate = {
  id: string;
  name: string;
  description: string;
  category: string;
  language: 'powershell' | 'bash' | 'python' | 'cmd';
  downloads: number;
};

type ScriptTemplateGalleryProps = {
  onUseTemplate?: (template: ScriptTemplate) => void;
};

const languageConfig: Record<ScriptTemplate['language'], { label: string; color: string }> = {
  powershell: { label: 'PowerShell', color: 'bg-blue-500/20 text-blue-700 border-blue-500/40' },
  bash: { label: 'Bash', color: 'bg-green-500/20 text-green-700 border-green-500/40' },
  python: { label: 'Python', color: 'bg-yellow-500/20 text-yellow-700 border-yellow-500/40' },
  cmd: { label: 'CMD', color: 'bg-gray-500/20 text-gray-700 border-gray-500/40' }
};

export default function ScriptTemplateGallery({ onUseTemplate }: ScriptTemplateGalleryProps) {
  const [templates, setTemplates] = useState<ScriptTemplate[]>([]);
  const [query, setQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [languageFilter, setLanguageFilter] = useState('all');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchTemplates = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const response = await fetchWithAuth('/scripts/templates');

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

  const handleUseTemplate = async (template: ScriptTemplate) => {
    try {
      // Track template usage
      await fetchWithAuth(`/scripts/templates/${template.id}/use`, {
        method: 'POST'
      });
    } catch {
      // Continue even if tracking fails
    }

    onUseTemplate?.(template);
  };

  const categories = useMemo(() => {
    const unique = Array.from(new Set(templates.map(template => template.category)));
    return unique.sort();
  }, [templates]);

  const filteredTemplates = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return templates.filter(template => {
      const matchesQuery = normalizedQuery.length === 0
        ? true
        : template.name.toLowerCase().includes(normalizedQuery) ||
          template.description.toLowerCase().includes(normalizedQuery);
      const matchesCategory = categoryFilter === 'all' ? true : template.category === categoryFilter;
      const matchesLanguage = languageFilter === 'all' ? true : template.language === languageFilter;
      return matchesQuery && matchesCategory && matchesLanguage;
    });
  }, [templates, query, categoryFilter, languageFilter]);

  if (isLoading) {
    return (
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold">Template Gallery</h2>
            <p className="text-sm text-muted-foreground">Browse reusable script templates.</p>
          </div>
        </div>
        <div className="mt-6 flex h-48 items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold">Template Gallery</h2>
            <p className="text-sm text-muted-foreground">Browse reusable script templates.</p>
          </div>
        </div>
        <div className="mt-6 flex h-48 flex-col items-center justify-center gap-2 text-muted-foreground">
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
          <h2 className="text-lg font-semibold">Template Gallery</h2>
          <p className="text-sm text-muted-foreground">Browse reusable script templates.</p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder="Search templates"
              className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-56"
            />
          </div>
          <select
            value={categoryFilter}
            onChange={event => setCategoryFilter(event.target.value)}
            className="h-10 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="all">All Categories</option>
            {categories.map(category => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
          </select>
          <select
            value={languageFilter}
            onChange={event => setLanguageFilter(event.target.value)}
            className="h-10 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="all">All Languages</option>
            <option value="powershell">PowerShell</option>
            <option value="bash">Bash</option>
            <option value="python">Python</option>
            <option value="cmd">CMD</option>
          </select>
        </div>
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {filteredTemplates.length === 0 ? (
          <div className="col-span-full py-8 text-center text-muted-foreground">
            No templates found matching your criteria.
          </div>
        ) : (
          filteredTemplates.map(template => (
            <div key={template.id} className="flex flex-col rounded-lg border bg-background p-4 shadow-sm">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h3 className="text-sm font-semibold">{template.name}</h3>
                  <p className="mt-1 text-xs text-muted-foreground">{template.category}</p>
                </div>
                <span
                  className={cn(
                    'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium',
                    languageConfig[template.language]?.color || 'bg-gray-500/20 text-gray-700 border-gray-500/40'
                  )}
                >
                  {languageConfig[template.language]?.label || template.language}
                </span>
              </div>
              <p className="mt-3 text-sm text-muted-foreground">{template.description}</p>
              <div className="mt-4 flex items-center justify-between text-xs text-muted-foreground">
                <span className="flex items-center gap-1">
                  <Download className="h-3 w-3" />
                  {template.downloads.toLocaleString()} downloads
                </span>
                <button
                  type="button"
                  onClick={() => handleUseTemplate(template)}
                  className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground"
                >
                  Use Template
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
