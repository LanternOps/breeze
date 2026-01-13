import { useMemo, useState } from 'react';

export type Site = {
  id: string;
  name: string;
  timezone: string;
  deviceCount: number;
};

type SiteListProps = {
  sites: Site[];
  onAddSite?: () => void;
  onEdit?: (site: Site) => void;
  onDelete?: (site: Site) => void;
};

export default function SiteList({ sites, onAddSite, onEdit, onDelete }: SiteListProps) {
  const [query, setQuery] = useState('');

  const filteredSites = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    if (!normalizedQuery) {
      return sites;
    }

    return sites.filter(site => site.name.toLowerCase().includes(normalizedQuery));
  }, [query, sites]);

  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Sites</h2>
          <p className="text-sm text-muted-foreground">
            {filteredSites.length} of {sites.length} sites
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <input
            type="search"
            placeholder="Search sites"
            value={query}
            onChange={event => setQuery(event.target.value)}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-56"
          />
          <button
            type="button"
            onClick={onAddSite}
            className="flex h-10 w-full items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 sm:w-auto"
          >
            Add site
          </button>
        </div>
      </div>

      <div className="mt-6 overflow-hidden rounded-md border">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Timezone</th>
              <th className="px-4 py-3">Devices</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {filteredSites.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-sm text-muted-foreground">
                  No sites found. Add a site to get started.
                </td>
              </tr>
            ) : (
              filteredSites.map(site => (
                <tr key={site.id} className="transition hover:bg-muted/40">
                  <td className="px-4 py-3 text-sm font-medium">{site.name}</td>
                  <td className="px-4 py-3 text-sm">{site.timezone}</td>
                  <td className="px-4 py-3 text-sm">{site.deviceCount}</td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => onEdit?.(site)}
                        className="rounded-md border px-3 py-1 text-xs font-medium hover:bg-muted"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => onDelete?.(site)}
                        className="rounded-md border border-destructive/40 px-3 py-1 text-xs font-medium text-destructive hover:bg-destructive/10"
                      >
                        Delete
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
