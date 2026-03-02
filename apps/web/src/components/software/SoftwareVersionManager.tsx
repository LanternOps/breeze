import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Download, Loader2, Plus, Sparkles, CheckCircle, Upload } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';

type Architecture = 'x64' | 'arm64' | 'x86';

type VersionEntry = {
  id: string;
  version: string;
  releaseDate: string;
  architecture: Architecture;
  fileType: string;
  originalFileName: string;
  notes: string[];
};

function formatDate(dateString: string, timezone?: string): string {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;
  return date.toLocaleDateString([], { timeZone: timezone });
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
    fileType: String(raw.fileType ?? ''),
    originalFileName: String(raw.originalFileName ?? ''),
    notes
  };
}

interface SoftwareVersionManagerProps {
  timezone?: string;
  catalogId?: string;
}

export default function SoftwareVersionManager({ timezone, catalogId: propCatalogId }: SoftwareVersionManagerProps) {
  const [versions, setVersions] = useState<VersionEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [latestId, setLatestId] = useState<string>('');
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [selectedVersionId, setSelectedVersionId] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [catalogId, setCatalogId] = useState(propCatalogId ?? '');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [formState, setFormState] = useState({
    version: '',
    architecture: 'x64' as Architecture,
    notes: '',
    silentInstallArgs: '',
    silentUninstallArgs: '',
    downloadUrl: '',
    supportedOs: [] as string[],
    file: null as File | null,
    fileName: ''
  });

  const fetchVersions = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);

      let resolvedCatalogId = propCatalogId ?? catalogId;

      if (!resolvedCatalogId) {
        const response = await fetchWithAuth('/software/catalog');
        if (!response.ok) throw new Error('Failed to fetch software catalog');

        const payload = await response.json();
        const catalogData = payload.data ?? payload ?? [];
        if (Array.isArray(catalogData) && catalogData.length > 0) {
          resolvedCatalogId = String((catalogData[0] as Record<string, unknown>).id);
          setCatalogId(resolvedCatalogId);
        }
      }

      if (!resolvedCatalogId) {
        setVersions([]);
        return;
      }

      const versionsResponse = await fetchWithAuth(`/software/catalog/${resolvedCatalogId}/versions`);
      if (versionsResponse.ok) {
        const versionsPayload = await versionsResponse.json();
        const versionsList = versionsPayload.data ?? versionsPayload.versions ?? versionsPayload ?? [];

        const normalizedVersions = Array.isArray(versionsList)
          ? versionsList.map((v: Record<string, unknown>, i: number) => normalizeVersion(v, i))
          : [];

        setVersions(normalizedVersions);

        if (normalizedVersions.length > 0) {
          setLatestId(normalizedVersions[0].id);
          setSelectedVersionId(normalizedVersions[0].id);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch versions');
    } finally {
      setLoading(false);
    }
  }, [propCatalogId, catalogId]);

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

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
    setFormState(prev => ({
      ...prev,
      file,
      fileName: file.name,
      // Auto-populate MSI silent args
      silentInstallArgs: ext === 'msi' && !prev.silentInstallArgs
        ? 'msiexec /i "{file}" /qn /norestart'
        : prev.silentInstallArgs,
      silentUninstallArgs: ext === 'msi' && !prev.silentUninstallArgs
        ? 'msiexec /x "{file}" /qn /norestart'
        : prev.silentUninstallArgs,
    }));
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!formState.version.trim()) return;
    if (!catalogId) return;

    try {
      setSaving(true);
      setUploadProgress(0);

      if (formState.file) {
        // File upload path
        const formData = new FormData();
        formData.append('file', formState.file);
        formData.append('version', formState.version.trim());
        formData.append('architecture', formState.architecture);
        if (formState.notes) formData.append('releaseNotes', formState.notes);
        if (formState.silentInstallArgs) formData.append('silentInstallArgs', formState.silentInstallArgs);
        if (formState.silentUninstallArgs) formData.append('silentUninstallArgs', formState.silentUninstallArgs);
        if (formState.downloadUrl) formData.append('downloadUrl', formState.downloadUrl);
        if (formState.supportedOs.length > 0) formData.append('supportedOs', JSON.stringify(formState.supportedOs));

        setUploadProgress(10);

        const response = await fetchWithAuth(`/software/catalog/${catalogId}/versions/upload`, {
          method: 'POST',
          body: formData,
          headers: {} // Let browser set Content-Type with boundary
        });

        setUploadProgress(90);

        if (!response.ok) {
          const errData = await response.json().catch(() => ({}));
          throw new Error(errData.error ?? 'Failed to upload version');
        }

        const newVersionData = await response.json();
        const newVersion = normalizeVersion(newVersionData.data ?? newVersionData, versions.length);

        setVersions(prev => [newVersion, ...prev]);
        setLatestId(newVersion.id);
        setSelectedVersionId(newVersion.id);
        setUploadProgress(100);
      } else {
        // JSON metadata-only path
        const response = await fetchWithAuth(`/software/catalog/${catalogId}/versions`, {
          method: 'POST',
          body: JSON.stringify({
            version: formState.version.trim(),
            releaseNotes: formState.notes || undefined,
            architecture: formState.architecture,
            silentInstallArgs: formState.silentInstallArgs || undefined,
            silentUninstallArgs: formState.silentUninstallArgs || undefined,
            downloadUrl: formState.downloadUrl || undefined,
            supportedOs: formState.supportedOs.length > 0 ? formState.supportedOs : undefined,
          })
        });

        if (!response.ok) throw new Error('Failed to create version');

        const newVersionData = await response.json();
        const newVersion = normalizeVersion(newVersionData.data ?? newVersionData, versions.length);

        setVersions(prev => [newVersion, ...prev]);
        setLatestId(newVersion.id);
        setSelectedVersionId(newVersion.id);
      }

      setFormState({ version: '', architecture: 'x64', notes: '', silentInstallArgs: '', silentUninstallArgs: '', downloadUrl: '', supportedOs: [], file: null, fileName: '' });
      if (fileInputRef.current) fileInputRef.current.value = '';
      setIsFormOpen(false);
    } catch (err) {
      console.error('Failed to create version:', err);
      setError(err instanceof Error ? err.message : 'Failed to create version');
    } finally {
      setSaving(false);
      setUploadProgress(0);
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
                placeholder="e.g. 1.0.0"
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
          </div>

          <div className="mt-4">
            <label className="text-xs font-semibold uppercase text-muted-foreground">Download URL</label>
            <input
              type="url"
              value={formState.downloadUrl}
              onChange={event => setFormState(prev => ({ ...prev, downloadUrl: event.target.value }))}
              placeholder="https://example.com/package-v1.0.0.msi"
              className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <p className="mt-1 text-xs text-muted-foreground">Provide a direct download URL or upload a file below</p>
          </div>

          <div className="mt-4">
            <label className="text-xs font-semibold uppercase text-muted-foreground">Supported OS</label>
            <div className="mt-2 flex items-center gap-4">
              {['Windows', 'macOS', 'Linux'].map(os => (
                <label key={os} className="inline-flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={formState.supportedOs.includes(os.toLowerCase())}
                    onChange={event => {
                      const value = os.toLowerCase();
                      setFormState(prev => ({
                        ...prev,
                        supportedOs: event.target.checked
                          ? [...prev.supportedOs, value]
                          : prev.supportedOs.filter(o => o !== value),
                      }));
                    }}
                    className="h-4 w-4 rounded border"
                  />
                  {os}
                </label>
              ))}
            </div>
          </div>

          <div className="mt-4">
            <label className="text-xs font-semibold uppercase text-muted-foreground">Package File</label>
            <div className="mt-2 flex items-center gap-3">
              <input
                ref={fileInputRef}
                type="file"
                accept=".msi,.exe,.dmg,.deb,.pkg"
                onChange={handleFileChange}
                className="hidden"
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex h-10 items-center gap-2 rounded-md border bg-background px-4 text-sm font-medium hover:bg-muted"
              >
                <Upload className="h-4 w-4" />
                Choose File
              </button>
              <span className="text-sm text-muted-foreground">
                {formState.fileName || 'No file selected (.msi, .exe, .dmg, .deb, .pkg)'}
              </span>
            </div>
          </div>

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <label className="text-xs font-semibold uppercase text-muted-foreground">Silent Install Args</label>
              <input
                type="text"
                value={formState.silentInstallArgs}
                onChange={event => setFormState(prev => ({ ...prev, silentInstallArgs: event.target.value }))}
                placeholder='e.g. msiexec /i "{file}" /qn /norestart'
                className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div>
              <label className="text-xs font-semibold uppercase text-muted-foreground">Silent Uninstall Args</label>
              <input
                type="text"
                value={formState.silentUninstallArgs}
                onChange={event => setFormState(prev => ({ ...prev, silentUninstallArgs: event.target.value }))}
                placeholder='e.g. msiexec /x "{file}" /qn /norestart'
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

          {saving && uploadProgress > 0 && (
            <div className="mt-4">
              <div className="h-2 w-full rounded-full bg-muted">
                <div
                  className="h-2 rounded-full bg-primary transition-all duration-300"
                  style={{ width: `${uploadProgress}%` }}
                />
              </div>
              <p className="mt-1 text-xs text-muted-foreground">Uploading... {uploadProgress}%</p>
            </div>
          )}

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
              {saving ? (formState.file ? 'Uploading...' : 'Saving...') : (formState.file ? 'Upload & Save' : 'Save Version')}
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
                <th className="px-4 py-3">Type</th>
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
                    <td className="px-4 py-3 text-muted-foreground">{formatDate(entry.releaseDate, timezone)}</td>
                    <td className="px-4 py-3">
                      <span className="rounded-full border px-2 py-1 text-xs font-medium text-muted-foreground">
                        {entry.architecture}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {entry.fileType ? entry.fileType.toUpperCase() : '—'}
                    </td>
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
                <p className="text-sm text-muted-foreground">Released {formatDate(latestVersion.releaseDate, timezone)}</p>
              </div>
              <div
                className={cn(
                  'rounded-md border p-4',
                  selectedVersion.id === latestVersion.id ? 'bg-emerald-500/10 border-emerald-500/30' : 'bg-muted/30'
                )}
              >
                <p className="text-xs uppercase text-muted-foreground">Selected build</p>
                <p className="mt-2 text-lg font-semibold">v{selectedVersion.version}</p>
                <p className="text-sm text-muted-foreground">Released {formatDate(selectedVersion.releaseDate, timezone)}</p>
                {selectedVersion.id === latestVersion.id && (
                  <p className="mt-2 text-xs text-emerald-600">Up to date</p>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
