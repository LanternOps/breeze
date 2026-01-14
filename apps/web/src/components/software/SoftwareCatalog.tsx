import { useMemo, useState } from 'react';
import {
  Search,
  Package,
  Globe,
  Flame,
  Code2,
  Video,
  MessageSquare,
  FileText,
  Shield,
  X,
  Rocket
} from 'lucide-react';
import { cn } from '@/lib/utils';

type SoftwareCategory = 'Browser' | 'Utilities' | 'Developer' | 'Collaboration' | 'Security' | 'Productivity';

type SoftwareItem = {
  id: string;
  name: string;
  vendor: string;
  latestVersion: string;
  category: SoftwareCategory;
  description: string;
  platforms: string[];
  size: string;
  lastUpdated: string;
  icon: typeof Package;
};

const categoryStyles: Record<SoftwareCategory, string> = {
  Browser: 'bg-blue-500/20 text-blue-700 border-blue-500/40',
  Utilities: 'bg-amber-500/20 text-amber-700 border-amber-500/40',
  Developer: 'bg-purple-500/20 text-purple-700 border-purple-500/40',
  Collaboration: 'bg-emerald-500/20 text-emerald-700 border-emerald-500/40',
  Security: 'bg-red-500/20 text-red-700 border-red-500/40',
  Productivity: 'bg-slate-500/20 text-slate-700 border-slate-500/40'
};

const softwareCatalog: SoftwareItem[] = [
  {
    id: 'sw-chrome',
    name: 'Google Chrome',
    vendor: 'Google',
    latestVersion: '122.0.6261.112',
    category: 'Browser',
    description: 'Fast, secure browser with enterprise policies and sync.',
    platforms: ['Windows', 'macOS', 'Linux'],
    size: '82 MB',
    lastUpdated: '2024-03-12',
    icon: Globe
  },
  {
    id: 'sw-firefox',
    name: 'Mozilla Firefox',
    vendor: 'Mozilla',
    latestVersion: '124.0',
    category: 'Browser',
    description: 'Privacy-focused browser with extended telemetry controls.',
    platforms: ['Windows', 'macOS', 'Linux'],
    size: '76 MB',
    lastUpdated: '2024-03-19',
    icon: Flame
  },
  {
    id: 'sw-7zip',
    name: '7-Zip',
    vendor: 'Igor Pavlov',
    latestVersion: '23.01',
    category: 'Utilities',
    description: 'High compression utility with secure archive support.',
    platforms: ['Windows'],
    size: '4.6 MB',
    lastUpdated: '2024-02-28',
    icon: Package
  },
  {
    id: 'sw-vscode',
    name: 'Visual Studio Code',
    vendor: 'Microsoft',
    latestVersion: '1.87.2',
    category: 'Developer',
    description: 'Developer IDE with extensions and remote development.',
    platforms: ['Windows', 'macOS', 'Linux'],
    size: '92 MB',
    lastUpdated: '2024-03-15',
    icon: Code2
  },
  {
    id: 'sw-zoom',
    name: 'Zoom',
    vendor: 'Zoom Video',
    latestVersion: '5.17.2',
    category: 'Collaboration',
    description: 'Video conferencing with SSO and admin-controlled updates.',
    platforms: ['Windows', 'macOS'],
    size: '128 MB',
    lastUpdated: '2024-03-08',
    icon: Video
  },
  {
    id: 'sw-slack',
    name: 'Slack',
    vendor: 'Salesforce',
    latestVersion: '4.37.0',
    category: 'Collaboration',
    description: 'Messaging platform with compliance exports and DLP.',
    platforms: ['Windows', 'macOS', 'Linux'],
    size: '112 MB',
    lastUpdated: '2024-03-10',
    icon: MessageSquare
  },
  {
    id: 'sw-adobe',
    name: 'Adobe Acrobat Reader',
    vendor: 'Adobe',
    latestVersion: '2024.001.20135',
    category: 'Productivity',
    description: 'PDF viewer with protected mode and controlled updates.',
    platforms: ['Windows', 'macOS'],
    size: '210 MB',
    lastUpdated: '2024-03-05',
    icon: FileText
  },
  {
    id: 'sw-defender',
    name: 'Microsoft Defender',
    vendor: 'Microsoft',
    latestVersion: '4.18.2402',
    category: 'Security',
    description: 'Endpoint security with AV and vulnerability protection.',
    platforms: ['Windows'],
    size: '150 MB',
    lastUpdated: '2024-03-17',
    icon: Shield
  }
];

export default function SoftwareCatalog() {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string>('all');
  const [selectedSoftware, setSelectedSoftware] = useState<SoftwareItem | null>(null);

  const categories = useMemo(() => {
    const unique = new Set(softwareCatalog.map(item => item.category));
    return Array.from(unique);
  }, []);

  const filteredSoftware = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return softwareCatalog.filter(item => {
      const matchesQuery =
        normalizedQuery.length === 0 ||
        item.name.toLowerCase().includes(normalizedQuery) ||
        item.vendor.toLowerCase().includes(normalizedQuery);
      const matchesCategory = category === 'all' ? true : item.category === category;
      return matchesQuery && matchesCategory;
    });
  }, [query, category]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold">Software Catalog</h1>
          <p className="text-sm text-muted-foreground">Browse and deploy approved software packages.</p>
        </div>
        <button
          type="button"
          className="inline-flex h-10 items-center justify-center gap-2 rounded-md border bg-background px-4 text-sm font-medium hover:bg-muted"
        >
          <Rocket className="h-4 w-4" />
          Bulk Deploy
        </button>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            placeholder="Search software, vendor..."
            value={query}
            onChange={event => setQuery(event.target.value)}
            className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <select
          value={category}
          onChange={event => setCategory(event.target.value)}
          className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-56"
        >
          <option value="all">All Categories</option>
          {categories.map(item => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {filteredSoftware.map(item => {
          const Icon = item.icon;

          return (
            <div
              key={item.id}
              className="group rounded-lg border bg-card p-5 shadow-sm transition hover:-translate-y-1 hover:shadow-md"
              role="button"
              tabIndex={0}
              onClick={() => setSelectedSoftware(item)}
              onKeyDown={event => {
                if (event.key === 'Enter' || event.key === ' ') {
                  setSelectedSoftware(item);
                }
              }}
            >
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-md bg-muted">
                    <Icon className="h-5 w-5 text-muted-foreground" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold">{item.name}</p>
                    <p className="text-xs text-muted-foreground">{item.vendor}</p>
                  </div>
                </div>
                <span
                  className={cn(
                    'inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium',
                    categoryStyles[item.category]
                  )}
                >
                  {item.category}
                </span>
              </div>

              <div className="mt-4 space-y-2 text-sm text-muted-foreground">
                <div className="flex items-center justify-between">
                  <span>Latest version</span>
                  <span className="font-medium text-foreground">{item.latestVersion}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Platforms</span>
                  <span>{item.platforms.join(', ')}</span>
                </div>
              </div>

              <div className="mt-4 flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Updated {item.lastUpdated}</span>
                <button
                  type="button"
                  onClick={event => {
                    event.stopPropagation();
                  }}
                  className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-xs font-semibold text-primary-foreground hover:bg-primary/90"
                >
                  Deploy
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {selectedSoftware && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-2xl rounded-lg border bg-card p-6 shadow-lg">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-md bg-muted">
                  <selectedSoftware.icon className="h-6 w-6 text-muted-foreground" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold">{selectedSoftware.name}</h2>
                  <p className="text-sm text-muted-foreground">{selectedSoftware.vendor}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setSelectedSoftware(null)}
                className="inline-flex h-9 w-9 items-center justify-center rounded-md border bg-background hover:bg-muted"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-4 rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground">
              {selectedSoftware.description}
            </div>

            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <div className="rounded-md border bg-background p-4">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Latest Version</p>
                <p className="mt-2 text-lg font-semibold text-foreground">{selectedSoftware.latestVersion}</p>
                <p className="mt-1 text-xs text-muted-foreground">Updated {selectedSoftware.lastUpdated}</p>
              </div>
              <div className="rounded-md border bg-background p-4">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Package Info</p>
                <p className="mt-2 text-sm text-foreground">Size: {selectedSoftware.size}</p>
                <p className="mt-1 text-sm text-foreground">Platforms: {selectedSoftware.platforms.join(', ')}</p>
              </div>
            </div>

            <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <span
                className={cn(
                  'inline-flex w-fit items-center rounded-full border px-3 py-1 text-xs font-medium',
                  categoryStyles[selectedSoftware.category]
                )}
              >
                {selectedSoftware.category}
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="inline-flex h-10 items-center justify-center rounded-md border bg-background px-4 text-sm font-medium hover:bg-muted"
                >
                  View Releases
                </button>
                <button
                  type="button"
                  className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                >
                  Deploy
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
