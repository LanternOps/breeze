import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, Download, Loader2, Plus, Sparkles, CheckCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';

type Architecture = 'x64' | 'arm64' | 'x86';

type VersionEntry = {
  id: string;
  version: string;
  releaseDate: string;
  architecture: Architecture;
  downloads: number;
  notes: string[];
};

function formatDate(dateString: string): string {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;
  return date.toLocaleDateString();
}

function normalizeVersion(raw: Record<string, unknown>, index: number): VersionEntry {
  const notesRaw = raw.notes ?? raw.releaseNotes ?? raw.changelog;
  let notes: string[] = [];
  if (typeof notesRaw === 'string') {
    notes = notesRaw.split('\n').map(n => n.trim()).filter(Boolean);
  } else if (Array.isArray(notesRaw)) {
    notes = notesRaw.map(n => String(n)).filter(Boolean);
  }

  const archRaw = raw.architecture ?? raw.arch ?? raw.platform ?? 'x64';
  let architecture: Architecture = 'x64';
  if (['arm64', 'arm', 'aarch64'].includes(String(archRaw).toLowerCase())) {
    architecture = 'arm64';
  } else if (['x86', 'i386', 'i686', '32bit'].includes(String(archRaw).toLowerCase())) {
    architecture = 'x86';
  }

  return {
    id: String(raw.id ?? raw.versionId ?? `ver-${index}`),
    version: String(raw.version ?? ''),
    releaseDate: String(raw.releaseDate ?? raw.releasedAt ?? ''),
    architecture,
    downloads: Number(raw.downloads ?? raw.downloadCount ?? 0),
    notes
  };
}

export default function SoftwareVersionManager() {
  const [versions, setVersions] = useState<VersionEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [latestId, setLatestId] = useState<string>('');
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [selectedVersionId, setSelectedVersionId] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [formState, setFormState] = useState({
    version: '',
    releaseDate: '',
    architecture: 'x64' as Architecture,
    downloads: '0',
    notes: ''
  });

  const fetchVersions = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);

      const response = await fetchWithAuth('/software/catalog');

      if (!response.ok) {
        throw new Error('Failed to fetch software versions');
      }

      const payload = await response.json();
      const catalogData = payload.data ?? payload ?? [];

      // Get first catalog item and fetch its versions
      if (Array.isArray(catalogData) && catalogData.length > 0) {
        const firstItem = catalogData[0] as Record<string, unknown>;
        const catalogId = firstItem.id;

        if (catalogId) {
          const versionsResponse = await fetchWithAuth(`/software/catalog/${catalogId}/versions`);
          if (versionsResponse.ok) {
            const versionsPayload = await versionsResponse.json();
            const versionsList = versionsPayload.data ?? versionsPayload.versions ?? versionsPayload ?? [];

            const normalizedVersions = Array.isArray(versionsList)
              ? versionsList.map((v: Record<string, unknown>, i: number) => normalizeVersion(v, i))
              : [];

            setVersions(normalizedVersions);

            if (normalizedVersions.length > 0) {
              const firstVersion = normalizedVersions[0];
              if (firstVersion) {
                setLatestId(firstVersion.id);
                setSelectedVersionId(firstVersion.id);
              }
            }
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch versions');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchVersions();
  }, [fetchVersions]);

  const latestVersion = useMemo(
    () => versions.find(item => item.id === latestId) ?? versions[0],
    [versions, latestId]
  );

  const selectedVersion = useMemo(
    () => versions.find(item => item.id === selectedVersionId) ?? versions[0],
    [versions, selectedVersionId]
  );

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!formState.version.trim()) return;

    try {
      setSaving(true);

      // Get the first catalog item ID to add version to
      const catalogResponse = await fetchWithAuth('/software/catalog');
      if (!catalogResponse.ok) {
        throw new Error('Failed to fetch catalog');
      }

      const catalogPayload = await catalogResponse.json();
      const catalogData = catalogPayload.data ?? catalogPayload ?? [];
      if (!Array.isArray(catalogData) || catalogData.length === 0) {
        throw new Error('No catalog items found');
      }

      const catalogId = (catalogData[0] as Record<string, unknown>).id;

      const response = await fetchWithAuth(`/software/catalog/${catalogId}/versions`, {
        method: 'POST',
        body: JSON.stringify({
          version: formState.version.trim(),
          releaseDate: formState.releaseDate || new Date().toISOString(),
          notes: formState.notes,
          downloadUrl: 'https://example.com/download',
          supportedPlatforms: ['windows', 'macos', 'linux']
        })
      });

      if (!response.ok) {
        throw new Error('Failed to create version');
      }

      const newVersionData = await response.json();
      const newVersion = normalizeVersion(newVersionData.data ?? newVersionData, versions.length);

      setVersions(prev => [newVersion, ...prev]);
      setLatestId(newVersion.id);
      setSelectedVersionId(newVersion.id);
      setFormState({ version: '', releaseDate: '', architecture: 'x64', downloads: '0', notes: '' });
      setIsFormOpen(false);
    } catch (err) {
      console.error('Failed to create version:', err);
      alert('Failed to create version. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <Loader2 className="mx-auto h-8 w-8 animate-spin text-muted-foreground" />
          <p className="mt-4 text-sm text-muted-foreground">Loading software versions...</p>
        </div>
      </div>
    );
  }

  if (error && versions.length === 0) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={fetchVersions}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold">Software Version Manager</h1>
          <p className="text-sm text-muted-foreground">Manage version history, latest builds, and release notes.</p>
        </div>
        <button
          type="button"
          onClick={() => setIsFormOpen(open => !open)}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-md border bg-background px-4 text-sm font-medium hover:bg-muted"
        >
          <Plus className="h-4 w-4" />
          Add Version
          {isFormOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {isFormOpen && (
        <form onSubmit={handleSubmit} className="rounded-lg border bg-card p-6 shadow-sm">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="text-xs font-semibold uppercase text-muted-foreground">Version</label>
              <input
                type="text"
                value={formState.version}
                onChange={event => setFormState(prev => ({ ...prev, version: event.target.value }))}
                placeholder="e.g. 125.0"
                className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div>
              <label className="text-xs font-semibold uppercase text-muted-foreground">Release Date</label>
              <input
                type="date"
                value={formState.releaseDate}
                onChange={event => setFormState(prev => ({ ...prev, releaseDate: event.target.value }))}
                className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div>
              <label className="text-xs font-semibold uppercase text-muted-foreground">Architecture</label>
              <select
                value={formState.architecture}
                onChange={event => setFormState(prev => ({ ...prev, architecture: event.target.value as Architecture }))}
                className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="x64">x64</option>
                <option value="arm64">arm64</option>
                <option value="x86">x86</option>
              </select>
            </div>
            <div>
              <label className="text-xs font-semibold uppercase text-muted-foreground">Download Count</label>
              <input
                type="number"
                value={formState.downloads}
                onChange={event => setFormState(prev => ({ ...prev, downloads: event.target.value }))}
                className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          </div>
          <div className="mt-4">
            <label className="text-xs font-semibold uppercase text-muted-foreground">Release Notes</label>
            <textarea
              value={formState.notes}
              onChange={event => setFormState(prev => ({ ...prev, notes: event.target.value }))}
              placeholder="One item per line"
              className="mt-2 min-h-[96px] w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div className="mt-4 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setIsFormOpen(false)}
              className="inline-flex h-9 items-center justify-center rounded-md border bg-background px-3 text-sm font-medium hover:bg-muted"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {saving ? 'Saving...' : 'Save Version'}
            </button>
          </div>
        </form>
      )}

      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">Version History</h2>
            <p className="text-sm text-muted-foreground">Track builds and set the latest package.</p>
          </div>
          {latestVersion && (
            <span className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium text-muted-foreground">
              <CheckCircle className="h-4 w-4 text-emerald-500" />
              Latest: {latestVersion.version}
            </span>
          )}
        </div>

        <div className="mt-5 overflow-hidden rounded-md border">
          <table className="min-w-full divide-y">
            <thead className="bg-muted/40">
              <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3">Version</th>
                <th className="px-4 py-3">Release Date</th>
                <th className="px-4 py-3">Architecture</th>
                <th className="px-4 py-3">Downloads</th>
                <th className="px-4 py-3">Latest</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {versions.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-sm text-muted-foreground">
                    No versions found.
                  </td>
                </tr>
              ) : (
                versions.map(entry => (
                  <tr key={entry.id} className="text-sm">
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        onClick={() => setSelectedVersionId(entry.id)}
                        className="text-left text-sm font-medium text-foreground hover:text-primary"
                      >
                        v{entry.version}
                      </button>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{formatDate(entry.releaseDate)}</td>
                    <td className="px-4 py-3">
                      <span className="rounded-full border px-2 py-1 text-xs font-medium text-muted-foreground">
                        {entry.architecture}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{entry.downloads.toLocaleString()}</td>
                    <td className="px-4 py-3">
                      <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                        <input
                          type="checkbox"
                          checked={entry.id === latestId}
                          onChange={() => setLatestId(entry.id)}
                          className="h-4 w-4 rounded border"
                        />
                        Set as latest
                      </label>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {selectedVersion && latestVersion && (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-lg border bg-card p-6 shadow-sm">
            <div className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-primary" />
              <h3 className="text-lg font-semibold">What's new</h3>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">Selected release highlights.</p>
            <div className="mt-4 space-y-3">
              {selectedVersion.notes.length === 0 ? (
                <p className="text-sm text-muted-foreground">No release notes for this build.</p>
              ) : (
                selectedVersion.notes.map(note => (
                  <div key={note} className="flex items-start gap-2 text-sm">
                    <span className="mt-1 h-2 w-2 rounded-full bg-primary" />
                    <span>{note}</span>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="rounded-lg border bg-card p-6 shadow-sm">
            <div className="flex items-center gap-2">
              <Download className="h-5 w-5 text-primary" />
              <h3 className="text-lg font-semibold">Version comparison</h3>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">Compare the selected build against latest.</p>

            <div className="mt-4 space-y-4">
              <div className="rounded-md border bg-muted/30 p-4">
                <p className="text-xs uppercase text-muted-foreground">Latest build</p>
                <p className="mt-2 text-lg font-semibold">v{latestVersion.version}</p>
                <p className="text-sm text-muted-foreground">Released {formatDate(latestVersion.releaseDate)}</p>
              </div>
              <div
                className={cn(
                  'rounded-md border p-4',
                  selectedVersion.id === latestVersion.id ? 'bg-emerald-500/10 border-emerald-500/30' : 'bg-muted/30'
                )}
              >
                <p className="text-xs uppercase text-muted-foreground">Selected build</p>
                <p className="mt-2 text-lg font-semibold">v{selectedVersion.version}</p>
                <p className="text-sm text-muted-foreground">Released {formatDate(selectedVersion.releaseDate)}</p>
                {selectedVersion.id === latestVersion.id ? (
                  <p className="mt-2 text-xs text-emerald-600">Up to date</p>
                ) : (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {latestVersion.downloads - selectedVersion.downloads > 0
                      ? `${(latestVersion.downloads - selectedVersion.downloads).toLocaleString()} fewer downloads than latest.`
                      : 'Adoption tracking in progress.'}
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
