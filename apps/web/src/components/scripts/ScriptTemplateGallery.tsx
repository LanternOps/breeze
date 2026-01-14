import { useMemo, useState } from 'react';
import { Download, Search } from 'lucide-react';
import { cn } from '@/lib/utils';

export type ScriptTemplate = {
  id: string;
  name: string;
  description: string;
  category: string;
  language: 'powershell' | 'bash' | 'python' | 'cmd';
  downloads: number;
};

type ScriptTemplateGalleryProps = {
  templates?: ScriptTemplate[];
  onUseTemplate?: (template: ScriptTemplate) => void;
};

const mockTemplates: ScriptTemplate[] = [
  {
    id: 'template-1',
    name: 'Disk Cleanup Starter',
    description: 'Clear temp files, browser cache, and rotate logs safely.',
    category: 'Maintenance',
    language: 'powershell',
    downloads: 1280
  },
  {
    id: 'template-2',
    name: 'Patch Compliance Audit',
    description: 'Check OS patch level across critical services and export a report.',
    category: 'Security',
    language: 'bash',
    downloads: 970
  },
  {
    id: 'template-3',
    name: 'User Offboarding',
    description: 'Disable accounts, archive mailboxes, and revoke tokens.',
    category: 'Automation',
    language: 'powershell',
    downloads: 1540
  },
  {
    id: 'template-4',
    name: 'VPN Rotation Helper',
    description: 'Rotate VPN credentials and refresh client configs.',
    category: 'Network',
    language: 'python',
    downloads: 820
  },
  {
    id: 'template-5',
    name: 'Service Health Probe',
    description: 'Probe services with retries and alert thresholds.',
    category: 'Monitoring',
    language: 'bash',
    downloads: 640
  },
  {
    id: 'template-6',
    name: 'Software Inventory',
    description: 'Collect installed software, versions, and licensing.',
    category: 'Reporting',
    language: 'python',
    downloads: 1120
  },
  {
    id: 'template-7',
    name: 'Endpoint Encryption',
    description: 'Enable disk encryption and verify escrowed keys.',
    category: 'Security',
    language: 'powershell',
    downloads: 1430
  },
  {
    id: 'template-8',
    name: 'CLI Bootstrapper',
    description: 'Install required CLI tools with version pinning.',
    category: 'Setup',
    language: 'cmd',
    downloads: 540
  }
];

const languageConfig: Record<ScriptTemplate['language'], { label: string; color: string }> = {
  powershell: { label: 'PowerShell', color: 'bg-blue-500/20 text-blue-700 border-blue-500/40' },
  bash: { label: 'Bash', color: 'bg-green-500/20 text-green-700 border-green-500/40' },
  python: { label: 'Python', color: 'bg-yellow-500/20 text-yellow-700 border-yellow-500/40' },
  cmd: { label: 'CMD', color: 'bg-gray-500/20 text-gray-700 border-gray-500/40' }
};

export default function ScriptTemplateGallery({ templates: externalTemplates, onUseTemplate }: ScriptTemplateGalleryProps) {
  const [query, setQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [languageFilter, setLanguageFilter] = useState('all');

  const templates = externalTemplates ?? mockTemplates;

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
        {filteredTemplates.map(template => (
          <div key={template.id} className="flex flex-col rounded-lg border bg-background p-4 shadow-sm">
            <div className="flex items-start justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold">{template.name}</h3>
                <p className="mt-1 text-xs text-muted-foreground">{template.category}</p>
              </div>
              <span
                className={cn(
                  'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium',
                  languageConfig[template.language].color
                )}
              >
                {languageConfig[template.language].label}
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
                onClick={() => onUseTemplate?.(template)}
                className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground"
              >
                Use Template
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
