import { useState, useMemo, useEffect, useCallback } from 'react';
import { X, Search, Cloud, Loader2, Plus, AlertTriangle, CloudOff } from 'lucide-react';
import {
  fetchM365ConnectionStatus,
  fetchOneDriveLibraries,
  type OneDriveLibrary,
} from '../../../lib/api/onedrive';

export type PickedLibrary = {
  libraryId: string;
  displayName: string;
  siteUrl: string;
  siteId: string;
  webId: string;
  listId: string;
};

type OneDriveLibraryPickerProps = {
  orgId?: string;
  onAdd: (lib: PickedLibrary) => void;
  onClose: () => void;
};

type SkippedSite = { siteId: string; code: string };

// State machine: while we don't yet know the connection status we're 'checking';
// a false status short-circuits to 'disconnected' WITHOUT ever fetching
// libraries (Graph call would 409). A true status flips us into the library
// list, which has its own loading/error/ready phases.
type Phase = 'checking' | 'disconnected' | 'loading' | 'error' | 'ready';

// Map a Graph library row to the wire shape the tab persists. libraryId is the
// composite autoMountValue; siteId is the BARE GUID (spSiteId), matching the DB
// column meaning — NOT the `siteId` field (which is the composite Graph id).
function toPicked(lib: OneDriveLibrary): PickedLibrary {
  return {
    libraryId: lib.autoMountValue,
    displayName: lib.libraryName,
    siteUrl: lib.siteUrl,
    siteId: lib.spSiteId,
    webId: lib.webId,
    listId: lib.listId,
  };
}

export default function OneDriveLibraryPicker({ orgId, onAdd, onClose }: OneDriveLibraryPickerProps) {
  const [phase, setPhase] = useState<Phase>('checking');
  const [error, setError] = useState<string>();
  const [libraries, setLibraries] = useState<OneDriveLibrary[]>([]);
  const [skippedSites, setSkippedSites] = useState<SkippedSite[]>([]);
  const [query, setQuery] = useState('');
  const [manualOpen, setManualOpen] = useState(false);

  const loadLibraries = useCallback(async () => {
    setPhase('loading');
    setError(undefined);
    try {
      const { libraries: libs, skippedSites: skipped } = await fetchOneDriveLibraries(orgId);
      setLibraries(libs);
      setSkippedSites(skipped);
      setPhase('ready');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load libraries.');
      setPhase('error');
    }
  }, [orgId]);

  // Check connection FIRST; only fetch libraries when actually connected.
  const checkConnection = useCallback(async () => {
    setPhase('checking');
    setError(undefined);
    try {
      const connected = await fetchM365ConnectionStatus(orgId);
      if (connected) {
        await loadLibraries();
      } else {
        setPhase('disconnected');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to check the Microsoft 365 connection.');
      setPhase('error');
    }
  }, [orgId, loadLibraries]);

  useEffect(() => {
    void checkConnection();
  }, [checkConnection]);

  // Group filtered libraries by site name, preserving first-seen order.
  const groups = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const matches = libraries.filter((lib) => {
      if (!normalized) return true;
      return (
        lib.libraryName.toLowerCase().includes(normalized) ||
        lib.siteName.toLowerCase().includes(normalized) ||
        lib.siteUrl.toLowerCase().includes(normalized)
      );
    });
    const bySite = new Map<string, OneDriveLibrary[]>();
    for (const lib of matches) {
      const bucket = bySite.get(lib.siteName);
      if (bucket) bucket.push(lib);
      else bySite.set(lib.siteName, [lib]);
    }
    return Array.from(bySite.entries());
  }, [libraries, query]);

  const handleAddLibrary = (lib: OneDriveLibrary) => onAdd(toPicked(lib));

  return (
    <div
      data-testid="onedrive-picker"
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8"
    >
      <div className="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border bg-card shadow-lg">
        {/* Header */}
        <div className="flex items-center justify-between border-b px-6 py-4">
          <div className="flex items-center gap-3">
            <Cloud className="h-5 w-5 text-primary" />
            <div>
              <h2 className="text-lg font-semibold">Add SharePoint library</h2>
              <p className="text-sm text-muted-foreground">
                Pick a document library to auto-mount, or paste a composite library ID.
              </p>
            </div>
          </div>
          <button
            type="button"
            data-testid="onedrive-picker-close"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Search (only meaningful in the connected list view) */}
        {phase === 'ready' && (
          <div className="border-b px-6 py-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                type="search"
                data-testid="onedrive-picker-search"
                placeholder="Search libraries or sites…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="h-9 w-full rounded-md border bg-background pl-9 pr-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              />
            </div>
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {(phase === 'checking' || phase === 'loading') && (
            <div data-testid="onedrive-picker-loading" className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          )}

          {phase === 'error' && (
            <div className="space-y-3 py-8 text-center">
              <div
                data-testid="onedrive-picker-error"
                className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
              >
                {error}
              </div>
              <button
                type="button"
                data-testid="onedrive-picker-retry"
                onClick={() => void checkConnection()}
                className="inline-flex items-center gap-2 rounded-md border px-4 py-2 text-sm font-medium transition hover:bg-muted"
              >
                Retry
              </button>
            </div>
          )}

          {phase === 'disconnected' && (
            <div data-testid="onedrive-picker-no-connection" className="space-y-4">
              <div className="flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3">
                <CloudOff className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
                <div className="text-sm">
                  <p className="font-medium">No Microsoft 365 connection</p>
                  <p className="mt-1 text-muted-foreground">
                    Connect this organization to Microsoft 365 to browse its SharePoint libraries. In the
                    meantime you can paste a composite library ID below.
                  </p>
                  <a
                    href="/integrations#m365"
                    className="mt-2 inline-block font-medium text-primary hover:underline"
                  >
                    Open Microsoft 365 connection settings →
                  </a>
                </div>
              </div>
              <ManualPaste onAdd={onAdd} />
            </div>
          )}

          {phase === 'ready' && (
            <div className="space-y-4">
              {skippedSites.length > 0 && (
                <div
                  data-testid="onedrive-picker-skipped-warning"
                  className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700"
                >
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  {skippedSites.length} {skippedSites.length === 1 ? 'site' : 'sites'} could not be read.
                </div>
              )}

              {groups.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  {libraries.length === 0 ? 'No document libraries found.' : 'No libraries match your search.'}
                </p>
              ) : (
                groups.map(([siteName, libs]) => (
                  <div key={siteName} className="space-y-2">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {siteName}
                    </h3>
                    <div className="space-y-2">
                      {libs.map((lib) => {
                        const disabled = !lib.autoMountValue;
                        return (
                          <div
                            key={lib.driveId}
                            className="flex items-center justify-between gap-3 rounded-lg border bg-background p-3"
                          >
                            <div className="min-w-0">
                              <p className="truncate text-sm font-medium">{lib.libraryName}</p>
                              {disabled ? (
                                <p className="truncate text-xs text-amber-600">
                                  This library has no mountable ID and can't be added.
                                </p>
                              ) : (
                                <p className="truncate text-xs text-muted-foreground">{lib.siteUrl}</p>
                              )}
                            </div>
                            <button
                              type="button"
                              data-testid={`onedrive-picker-add-${lib.driveId}`}
                              onClick={() => handleAddLibrary(lib)}
                              disabled={disabled}
                              className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-primary/40 px-3 py-1.5 text-sm font-medium text-primary transition hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              <Plus className="h-4 w-4" />
                              Add
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))
              )}

              {/* Manual paste stays available as a secondary path in the connected view. */}
              <div className="border-t pt-3">
                <button
                  type="button"
                  data-testid="onedrive-picker-manual-toggle"
                  onClick={() => setManualOpen((v) => !v)}
                  className="text-sm font-medium text-muted-foreground hover:text-foreground"
                >
                  {manualOpen ? 'Hide manual entry' : 'Paste a library ID instead'}
                </button>
                {manualOpen && (
                  <div className="mt-3">
                    <ManualPaste onAdd={onAdd} />
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end border-t px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

// Composite-ID paste fallback. Validates the `tenantId=` prefix (mirrors the
// server-side library-id format) so bad input is caught before it reaches Save.
function ManualPaste({ onAdd }: { onAdd: (lib: PickedLibrary) => void }) {
  const [manualId, setManualId] = useState('');
  const [manualName, setManualName] = useState('');
  const [manualError, setManualError] = useState<string | null>(null);

  const submit = () => {
    const libraryId = manualId.trim();
    const displayName = manualName.trim();
    if (!libraryId.startsWith('tenantId=')) {
      setManualError('Library ID must start with "tenantId=" (paste the composite ID from SharePoint).');
      return;
    }
    if (!displayName) {
      setManualError('Display name is required.');
      return;
    }
    onAdd({ libraryId, displayName, siteUrl: '', siteId: '', webId: '', listId: '' });
    setManualId('');
    setManualName('');
    setManualError(null);
  };

  return (
    <div className="space-y-3 rounded-md border border-dashed bg-muted/30 px-4 py-4">
      <div>
        <label className="text-sm font-medium">Composite library ID</label>
        <input
          type="text"
          data-testid="onedrive-picker-manual-id"
          value={manualId}
          onChange={(e) => setManualId(e.target.value)}
          placeholder="tenantId=…&siteId=…&webId=…&listId=…"
          className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
        />
      </div>
      <div>
        <label className="text-sm font-medium">Display name</label>
        <input
          type="text"
          data-testid="onedrive-picker-manual-name"
          value={manualName}
          onChange={(e) => setManualName(e.target.value)}
          placeholder="e.g. Marketing Share"
          className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
        />
      </div>
      {manualError && (
        <p data-testid="onedrive-picker-manual-error" className="text-xs text-destructive">
          {manualError}
        </p>
      )}
      <div className="flex justify-end">
        <button
          type="button"
          data-testid="onedrive-picker-manual-submit"
          onClick={submit}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90"
        >
          Add
        </button>
      </div>
    </div>
  );
}
