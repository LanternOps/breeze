import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useWorkspaceStore, type FinderFile } from '../../stores/workspaceStore';
import { useChatStore } from '../../stores/chatStore';
import { getTauriInvoke } from '../../lib/helperFetch';
import { SegmentedControl } from '../ui/SegmentedControl';
import { Toaster, toast } from '../ui/Toaster';
import { EmptyState } from '../ui/EmptyState';
import { SkeletonRows } from '../ui/SkeletonRows';
import { FileTable } from './FileTable';
import { FilterChips } from './FilterChips';
import { FilingCard } from './FilingCard';
import { ProjectRail } from './ProjectRail';

const isMacOS =
  navigator.platform.startsWith('Mac') || navigator.userAgent.includes('Macintosh');

type WorkspaceTab = 'search' | 'browse' | 'recents' | 'filing';

/**
 * The search snippet arrives as ts_headline output: plain text plus <b> marks.
 * Escape EVERYTHING, then restore only the exact <b>/</b> tokens — no other
 * markup (or attributes) can survive, whatever the indexed file contained.
 */
function safeSnippetHtml(snippet: string): string {
  return snippet
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replaceAll('&lt;b&gt;', '<b>')
    .replaceAll('&lt;/b&gt;', '</b>');
}

export function formatWhen(dateStr: string | null | undefined): string | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return null;
  const diffMs = Date.now() - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString();
}

/**
 * Second line under a file's name in the list-table: content-preview extras
 * only (the Project/Doc-type columns already cover the plain inferred
 * fields) — a search snippet, a filed-vs-reads-as mismatch banner, and the
 * open-failure fallback note. Returns null when a row has none of these.
 */
function renderFileMeta(file: FinderFile, openError: boolean): ReactNode {
  const showDisagreement = file.metadataDisagreement
    && (file.inferredDocType || file.inferredProjectLabel);
  const readsAs = [file.inferredDocType, file.inferredProjectLabel]
    .filter(Boolean).join(' — ');

  if (!file.snippet && !showDisagreement && !openError) return null;

  return (
    <>
      {file.snippet && (
        <span
          className="ws-file-table-snippet"
          dangerouslySetInnerHTML={{ __html: safeSnippetHtml(file.snippet) }}
        />
      )}
      {showDisagreement && (
        <span className="ws-file-table-mismatch">
          Filed in: {file.declaredProjectLabel ?? file.parentPath} · Reads as: {readsAs}
        </span>
      )}
      {openError && (
        <span className="ws-file-table-open-error">
          Couldn't open — the share may be unreachable from this machine. Path copied
          instead.
        </span>
      )}
    </>
  );
}

/** List-level fetch failure: the store's error message plus a retry action. */
function ErrorRow({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="ws-error-row">
      <span>{message}</span> —{' '}
      <button type="button" className="ws-error-retry" onClick={onRetry}>
        retry
      </button>
    </div>
  );
}

export default function WorkspacePanel({
  onClose,
  embedded = false,
}: {
  onClose: () => void;
  // Rendered inside AppShell's main region: the shell owns the one header, so
  // suppress this panel's own header/Back and let the shell nav own switching
  // (onClose goes unused in this mode). Default false keeps the standalone
  // full-window rendering — and every existing screenshot/test — valid.
  embedded?: boolean;
}) {
  const {
    sources,
    results,
    entries,
    recent,
    department,
    filings,
    projects,
    contentEnabled,
    contentFeatures,
    loading,
    error,
    filingBusy,
    browsePath,
    filters,
    search,
    browse,
    loadRecents,
    recordActivity,
    loadFilings,
    classifyEmail,
    assignFiling,
    fileByDrop,
    setFilter,
    clearFilter,
  } = useWorkspaceStore();
  const username = useChatStore((s) => s.username);

  const [tab, setTab] = useState<WorkspaceTab>('search');
  const [query, setQuery] = useState('');
  const [openErrorId, setOpenErrorId] = useState<string | null>(null);
  // Tracks which FilingCard (by id) was most recently dropped onto the
  // ProjectRail, so only the onDrop path — not click-to-file or the inline
  // reassign select — triggers the card's settle animation + toast.
  const [pendingDropId, setPendingDropId] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const focusSearchPending = useRef(false);
  // Key (query + filters) of the last search that completed *successfully*,
  // so the debounce effect below can tell "revisiting an already-loaded
  // Search view" apart from "query/filters actually changed" and skip
  // re-arming the timer in the former case. Not updated on failure: a
  // failed fetch left no valid content to protect, so a later revisit
  // re-attempting the fetch is fine (and is the only way it'd ever recover
  // without the user retyping).
  const lastSuccessKeyRef = useRef<string | null>(null);
  // Browse's analogue: key (sourceId, parentPath, project, docType) of the
  // last browse that completed successfully. The Browse chip/tab effect below
  // re-runs on browsePath *and* tab changes now, so without this a rail
  // click (which already fetched) or a tab revisit with unchanged state would
  // redundantly re-fetch. Seeded to null, NOT from the initial browsePath +
  // current filters: `filters` reflects whatever is active right now, not
  // what was actually fetched to produce the currently-loaded `entries` —
  // those can diverge (e.g. a project chip set from Search after the last
  // Browse fetch, then the panel closed and reopened while `browsePath`
  // survives in the module-level store). Trusting current filters at seed
  // time would let a stale, wrongly-filtered (or wrongly-unfiltered) view
  // through unrefreshed. Seeding null means the first Browse entry after a
  // fresh mount always re-fetches once — a one-time, acceptable cost for
  // guaranteed correctness — after which this ref is only ever written from
  // an actual successful fetch's key (see `runBrowse`), so subsequent
  // skip/refetch decisions are always trustworthy.
  const lastBrowseKeyRef = useRef<string | null>(null);

  // `error` is a single store field shared by all four views (Search,
  // Browse, Recents, Filing), cleared only when the view whose fetch set it
  // re-runs. A tab's own mount/debounce effect can no-op on revisit (Browse
  // when `browsePath` is already set; Search when `query`/`filters` haven't
  // changed), so without this, an error from one tab can persist and
  // incorrectly gate a different (already-loaded) tab's content after
  // switching. Route every tab change through here so the stale error never
  // outlives the tab that produced it.
  const switchTab = (next: WorkspaceTab) => {
    if (next !== tab) useWorkspaceStore.setState({ error: null });
    setTab(next);
  };

  // `error` lives in the module-level store, so it survives this component's
  // own unmount/remount (WorkspacePanel is conditionally rendered by
  // App.tsx's `showWorkspace` gate — closing and reopening Files is a normal
  // user action, not a tab switch, so `switchTab`'s guard above never runs
  // for it). Without this, a leftover error from a session before the panel
  // was last closed (or before the user ever switched tabs) would render as
  // a stale `ErrorRow` on whichever tab mounts first (`search`), masking
  // that tab's correct empty/loaded state. Clear it once, on mount, the same
  // way `switchTab` clears it on an in-panel tab change.
  useEffect(() => {
    useWorkspaceStore.setState({ error: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Runs a Search fetch and records its (query, filters) key on success only,
  // so the debounce effect and the error row's "retry" button share one
  // notion of "this exact query/filters combo is already loaded" — see
  // `lastSearchKeyRef` above.
  const runSearch = (q: string, searchFilters: typeof filters) => {
    const key = JSON.stringify([q, searchFilters]);
    void search(q, searchFilters).then(() => {
      if (!useWorkspaceStore.getState().error) lastSuccessKeyRef.current = key;
    });
  };

  // Browse's single choke point (mirrors runSearch): every browse call site —
  // the mount "open first source" effect, the chip/tab effect, rail clicks,
  // breadcrumbs, drill-down, reveal, and the ErrorRow retry — routes through
  // here so the (sourceId, parentPath, filters) key is recorded on success
  // only. That lets the chip/tab effect below skip re-fetching a folder that's
  // already loaded (browse() reads the same `filters` slice via getState()).
  const runBrowse = (sourceId: string, parentPath: string) => {
    const { project, docType } = useWorkspaceStore.getState().filters;
    const key = JSON.stringify([sourceId, parentPath, project, docType]);
    void browse(sourceId, parentPath).then(() => {
      if (!useWorkspaceStore.getState().error) lastBrowseKeyRef.current = key;
    });
  };

  // Debounced search (300 ms). This effect is reactive ONLY to user-meaningful
  // inputs — query, filters, tab. It is deliberately NOT reactive to `error`
  // or `loading`: making `error` a dependency creates an auto-retry loop,
  // because `search()` writes `error` (null → message) on every failed attempt,
  // which would re-run the effect, re-arm the timer, and refetch the failing
  // query forever. Instead the effect reads transient store state
  // non-reactively via `getState()` when it runs (the standard zustand
  // pattern — no dependency entry, no eslint-disable needed for those reads).
  //
  // `tab` is a dependency (not just read once) so that navigating away from
  // Search runs this effect's cleanup — cancelling any pending timer —
  // before the effect body re-evaluates and bails out via the guard below.
  // Without this, a timer armed while on Search could still fire after the
  // user switched to another (already-loaded) tab: `search()` would resolve
  // later and set the store's global `error`, masking that other tab's
  // correct content with a stale, wrong-context ErrorRow.
  //
  // Empty query: if an ErrorRow is currently showing (e.g. the user just
  // cleared a failed query), clear the store `error` so the "Search your
  // firm's files" EmptyState shows instead of a stale error, then return
  // without arming a timer.
  //
  // Skip guard: skip arming ONLY when the (query, filters) key matches the
  // last *successful* search AND no error is currently set. The `error == null`
  // half is what lets "search alder (ok) → search boblegal (fails) → retype
  // alder" recover: the key matches alder's earlier success, but because an
  // error is set the guard falls through and refetches (clearing the error).
  // Reading `error` via getState() here — not as a dependency — is exactly
  // what keeps a failing query's own `error` writes from re-running the effect.
  useEffect(() => {
    if (tab !== 'search') return;
    const q = query.trim();
    const store = useWorkspaceStore.getState();
    if (!q) {
      if (store.error) useWorkspaceStore.setState({ error: null });
      return;
    }
    const key = JSON.stringify([q, filters]);
    if (key === lastSuccessKeyRef.current && store.error == null) return;
    const timer = setTimeout(() => {
      runSearch(q, filters);
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, query, filters, search]);

  // Load recents when the tab is shown.
  useEffect(() => {
    if (tab === 'recents') loadRecents(username);
  }, [tab, username, loadRecents]);

  // Load unfiled mail when the Filing tab is shown.
  const filingEnabled = contentEnabled === true && contentFeatures.includes('filing');
  useEffect(() => {
    if (tab === 'filing' && filingEnabled) loadFilings();
  }, [tab, filingEnabled, loadFilings]);

  // Open the first source when Browse is shown for the first time.
  useEffect(() => {
    if (tab !== 'browse' || browsePath || sources.length === 0) return;
    runBrowse(sources[0].id, '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, browsePath, sources]);

  // Browse's own chip row (Project/Doc type only — see FilterChips' `chips`
  // prop below) writes to the same `filters` slice Search's chips use.
  // Selecting or clearing either one re-issues the current folder's browse
  // fetch with the new filters.
  //
  // `tab` is a dependency (mirroring the search effect): the shared `filters`
  // slice can change while the user is on *another* tab (Search's chip row
  // writes the same filters.project/docType). Without `tab` here, returning to
  // Browse after such a change wouldn't re-run this effect, leaving Browse
  // showing active chips over a stale list. `browsePath` is a dependency too so
  // a rail click / drill-down re-evaluates the guard. The lastBrowseKeyRef
  // guard then skips the redundant re-fetch when nothing that browse() reads
  // (sourceId, parentPath, project, docType) actually changed — so a rail
  // click (which already fetched via runBrowse) or a tab revisit with
  // unchanged state doesn't double-fetch.
  //
  // Skip guard: mirrors the search debounce effect's guard exactly — skip
  // ONLY when the key matches the last *successful* browse AND no error is
  // currently set (read via getState(), not a dependency, for the same
  // reason as the search effect: adding `error` as a dependency would let
  // browse()'s own error writes re-run this effect and auto-retry forever).
  // Without the `!error` half: browse (s1, docs) unfiltered succeeds (key
  // recorded) -> a project chip set on Search -> returning to Browse re-runs
  // this effect, the filtered key doesn't match, so it fetches and FAILS
  // (error set; the key is only recorded on success, so lastBrowseKeyRef is
  // unchanged) -> clearing the chip mutates only `filters`, never `error` ->
  // the effect re-runs with a key that once again matches the earlier
  // unfiltered success, and a key-only guard would skip, leaving a stale
  // ErrorRow masking the folder's still-valid entries indefinitely.
  useEffect(() => {
    if (tab !== 'browse' || !browsePath) return;
    const key = JSON.stringify([
      browsePath.sourceId, browsePath.parentPath, filters.project, filters.docType,
    ]);
    if (key === lastBrowseKeyRef.current && !useWorkspaceStore.getState().error) return;
    runBrowse(browsePath.sourceId, browsePath.parentPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, browsePath, filters.project, filters.docType]);

  // Cmd/Ctrl+F focuses the search input from anywhere in Files, switching to
  // the Search tab first if another tab is active.
  useEffect(() => {
    const handleShortcut = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'f') return;
      e.preventDefault();
      if (tab !== 'search') {
        focusSearchPending.current = true;
        switchTab('search');
      } else {
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, [tab]);

  useEffect(() => {
    if (tab === 'search' && focusSearchPending.current) {
      focusSearchPending.current = false;
      searchInputRef.current?.focus();
    }
  }, [tab]);

  const handleCopyPath = (file: FinderFile) => {
    const path = file.openPath ?? file.relPath;
    navigator.clipboard.writeText(path).catch(() => {});
    recordActivity(file.id, 'copy_path', username);
    toast('Path copied');
  };

  const handleOpen = async (file: FinderFile) => {
    if (!file.openPath) return;
    setOpenErrorId((cur) => (cur === file.id ? null : cur));
    await recordActivity(file.id, 'open', username);
    try {
      const invoke = await getTauriInvoke();
      if (!invoke) {
        throw new Error('Opening files requires the desktop app');
      }
      await invoke('open_workspace_path', { input: { path: file.openPath } });
    } catch {
      // Fallback: put the path on the clipboard and say so on the row.
      navigator.clipboard.writeText(file.openPath).catch(() => {});
      setOpenErrorId(file.id);
    }
  };

  const handleReveal = (file: FinderFile) => {
    recordActivity(file.id, 'reveal', username);
    switchTab('browse');
    runBrowse(file.sourceId, file.parentPath);
  };

  // Browse's Open drills into directories instead of opening them in place.
  const handleBrowseOpen = (file: FinderFile) => {
    if (file.isDir) {
      if (browsePath) runBrowse(browsePath.sourceId, file.relPath);
      return;
    }
    handleOpen(file);
  };

  const activeSource = browsePath ? sources.find((s) => s.id === browsePath.sourceId) : null;
  const crumbSegments = browsePath
    ? browsePath.parentPath.split('/').filter(Boolean)
    : [];

  // Escape walk-back: an open Radix menu handles its own Escape first; a
  // FileTable with an active row selection stops this event from bubbling
  // here (it clears the selection instead) — only once neither has anything
  // left to clear does Escape reach the panel and go Back.
  const handlePanelKeyDown = (e: React.KeyboardEvent) => {
    // Embedded in the shell, Escape has no "close" to do — nav owns switching.
    if (e.key === 'Escape' && !embedded) onClose();
  };

  return (
    <div className="helper-container" onKeyDown={handlePanelKeyDown} data-testid="workspace-panel">
      <Toaster />
      {!embedded && (
        <div
          className={`helper-header${isMacOS ? ' helper-header-macos' : ''}`}
          data-tauri-drag-region
        >
          <div className="helper-header-left" data-tauri-drag-region>
            {isMacOS && <div className="helper-traffic-light-spacer" />}
            <span className="helper-title">Files</span>
          </div>
          <div className="helper-header-drag-spacer" data-tauri-drag-region />
          <div className="helper-header-actions">
            <button onClick={onClose} className="helper-btn helper-btn-sm">
              Back
            </button>
          </div>
        </div>
      )}

      <div className="helper-workspace-tabs">
        <SegmentedControl
          options={[
            { key: 'search', label: 'Search' },
            { key: 'browse', label: 'Browse' },
            { key: 'recents', label: 'Recents' },
            ...(filingEnabled ? [{ key: 'filing', label: 'Filing' }] : []),
          ]}
          value={tab}
          onChange={(key) => switchTab(key as WorkspaceTab)}
        />
      </div>

      {tab === 'search' && (
        <div className="helper-workspace-body">
          <div className="helper-workspace-toolbar">
            <input
              ref={searchInputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search shared files..."
              className="helper-workspace-search-input"
              autoFocus
            />
          </div>
          <FilterChips
            rows={results}
            sources={sources}
            filters={filters}
            onSetFilter={setFilter}
            onClearFilter={clearFilter}
          />
          <div className="helper-workspace-list">
            {loading && <SkeletonRows />}
            {!loading && error && (
              <ErrorRow message={error} onRetry={() => runSearch(query.trim(), filters)} />
            )}
            {!loading && !error && !query.trim() && (
              <EmptyState
                title="Search your firm's files"
                hint="Everything indexed from your shares, searchable by name and content."
              />
            )}
            {!loading && !error && query.trim() && results.length === 0 && (
              <EmptyState
                title={`No matches for '${query.trim()}'`}
                hint="Try fewer words, or clear filters."
              />
            )}
            {!loading && !error && query.trim() && results.length > 0 && (
              <FileTable
                view="search"
                rows={results}
                onOpen={handleOpen}
                onCopy={handleCopyPath}
                onReveal={handleReveal}
                renderMeta={(file) => renderFileMeta(file, openErrorId === file.id)}
                sources={sources}
              />
            )}
          </div>
        </div>
      )}

      {tab === 'browse' && (
        <div className="helper-workspace-browse">
          <div className="helper-workspace-rail">
            {sources.map((s) => (
              <button
                key={s.id}
                className={`helper-workspace-rail-item${
                  browsePath?.sourceId === s.id ? ' helper-workspace-rail-item-active' : ''
                }`}
                onClick={() => runBrowse(s.id, '')}
                title={s.displayName}
              >
                {s.displayName}
              </button>
            ))}
            {sources.length === 0 && (
              <span className="helper-workspace-rail-empty">No sources yet</span>
            )}
          </div>
          <div className="helper-workspace-main">
            {browsePath && (
              <FilterChips
                rows={entries}
                sources={sources}
                filters={filters}
                onSetFilter={setFilter}
                onClearFilter={clearFilter}
                chips={['project', 'docType']}
              />
            )}
            {browsePath && (
              <div className="helper-workspace-breadcrumb">
                <button
                  className="helper-workspace-crumb"
                  onClick={() => runBrowse(browsePath.sourceId, '')}
                >
                  {activeSource?.displayName ?? 'Top'}
                </button>
                {crumbSegments.map((seg, i) => (
                  <span key={`${seg}-${i}`}>
                    <span className="helper-workspace-crumb-sep"> / </span>
                    <button
                      className="helper-workspace-crumb"
                      onClick={() =>
                        runBrowse(browsePath.sourceId, crumbSegments.slice(0, i + 1).join('/'))
                      }
                    >
                      {seg}
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="helper-workspace-list">
              {loading && <SkeletonRows />}
              {!loading && error && (
                <ErrorRow
                  message={error}
                  onRetry={() =>
                    browsePath
                      ? runBrowse(browsePath.sourceId, browsePath.parentPath)
                      : sources[0] && runBrowse(sources[0].id, '')
                  }
                />
              )}
              {!loading && !error && browsePath && entries.length === 0 && (
                filters.project || filters.docType ? (
                  <EmptyState
                    title="No matches in this folder"
                    hint="Clear filters to see everything."
                  />
                ) : (
                  <EmptyState title="This folder is empty" />
                )
              )}
              {!loading && !error && entries.length > 0 && (
                <FileTable
                  view="browse"
                  rows={entries}
                  onOpen={handleBrowseOpen}
                  onCopy={handleCopyPath}
                  renderMeta={(file) => renderFileMeta(file, openErrorId === file.id)}
                />
              )}
            </div>
          </div>
        </div>
      )}

      {tab === 'filing' && (
        <div className="helper-workspace-body">
          <div className="ws-filing-layout">
            <div className="ws-filing-cards">
              {loading && <SkeletonRows />}
              {!loading && error && (
                <ErrorRow message={error} onRetry={loadFilings} />
              )}
              {!loading && !error && filings.length === 0 && (
                <EmptyState
                  title="All mail filed"
                  hint="New unfiled mail will appear here."
                />
              )}
              {!loading && !error && filings.length > 0 && (
                <>
                  <div className="helper-workspace-section-title">Unfiled mail</div>
                  {filings.map((filing) => (
                    <FilingCard
                      key={filing.fileIndexId}
                      filing={filing}
                      projects={projects}
                      busy={filingBusy === filing.fileIndexId}
                      onClassify={classifyEmail}
                      onAssign={(id, key) => assignFiling(id, key, username)}
                      viaDrop={pendingDropId === filing.fileIndexId}
                    />
                  ))}
                </>
              )}
            </div>
            <ProjectRail
              projects={projects}
              onDropEmail={(id, key) => {
                setPendingDropId(id);
                fileByDrop(id, key, username);
              }}
            />
          </div>
        </div>
      )}

      {tab === 'recents' && (
        <div className="helper-workspace-body">
          <div className="helper-workspace-list">
            {loading && <SkeletonRows />}
            {!loading && error && (
              <ErrorRow message={error} onRetry={() => loadRecents(username)} />
            )}
            {!loading && !error && (
              <>
                <div className="helper-workspace-section-title">Your recent files</div>
                {recent.length === 0 && (
                  <EmptyState
                    title="Nothing recent yet"
                    hint="Files you open or copy will show up here."
                  />
                )}
                {recent.length > 0 && (
                  <FileTable
                    view="recents"
                    rows={recent}
                    onOpen={handleOpen}
                    onCopy={handleCopyPath}
                    onReveal={handleReveal}
                    renderMeta={(file) => renderFileMeta(file, openErrorId === file.id)}
                    sources={sources}
                  />
                )}
                <div className="helper-workspace-section-title">
                  Recently active in your company
                </div>
                {department.length === 0 && (
                  <div className="helper-history-empty">Nothing here yet.</div>
                )}
                {department.length > 0 && (
                  <FileTable
                    view="recents"
                    // "Modified" reflects the activity feed's timestamp here,
                    // not the file's own mtime — same field sortRows reads.
                    rows={department.map((d) => ({ ...d, mtime: d.lastActivityAt }))}
                    onOpen={handleOpen}
                    onCopy={handleCopyPath}
                    onReveal={handleReveal}
                    renderMeta={(file) => renderFileMeta(file, openErrorId === file.id)}
                    sources={sources}
                  />
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
