import { useEffect, useState, type ReactNode } from 'react';
import {
  useWorkspaceStore, type FinderFile, type FilingRecord,
} from '../../stores/workspaceStore';
import { useChatStore } from '../../stores/chatStore';
import { getTauriInvoke } from '../../lib/helperFetch';
import { SegmentedControl } from '../ui/SegmentedControl';
import { FileTable } from './FileTable';
import { FilterChips } from './FilterChips';

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

function formatWhen(dateStr: string | null | undefined): string | null {
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

function LoadingRow() {
  return (
    <div className="helper-history-loading">
      <span className="helper-spinner" />
      <span>Loading...</span>
    </div>
  );
}

function FilingRow({
  filing,
  projects,
  busy,
  onClassify,
  onAssign,
}: {
  filing: FilingRecord;
  projects: Array<{ key: string; label: string }>;
  busy: boolean;
  onClassify: (fileIndexId: string) => void;
  onAssign: (fileIndexId: string, projectKey: string) => void;
}) {
  const [choice, setChoice] = useState('');
  const subject = filing.emailMeta?.subject ?? filing.name;
  const decided = filing.status === 'confirmed' || filing.status === 'reassigned';
  const decidedLabel = filing.decidedProjectKey
    ? projects.find((p) => p.key === filing.decidedProjectKey)?.label ?? filing.decidedProjectKey
    : null;

  return (
    <div className="helper-file-row helper-filing-row">
      <div className="helper-file-main">
        <span className="helper-file-name">{subject}</span>
        <span className="helper-file-meta">
          {[filing.emailMeta?.from, formatWhen(filing.emailMeta?.date)].filter(Boolean).join(' · ')}
        </span>
        {decided && (
          <span className="helper-filing-banner helper-filing-decided">
            Filed to: {decidedLabel}
          </span>
        )}
        {!decided && filing.status === 'suggested' && filing.suggestedProjectLabel && (
          <span
            className={`helper-filing-banner${
              filing.confidence === 'high' ? ' helper-filing-confident' : ' helper-filing-tentative'
            }`}
          >
            {filing.confidence === 'high'
              ? `Filed to: ${filing.suggestedProjectLabel} — ${filing.rationale}`
              : `Possibly ${filing.suggestedProjectLabel} — ${filing.rationale}`}
          </span>
        )}
        {!decided && filing.status === 'suggested' && !filing.suggestedProjectLabel && (
          <span className="helper-filing-banner helper-filing-tentative">
            No clear match — pick a project below.
          </span>
        )}
      </div>
      <div className="helper-file-actions helper-filing-actions">
        {busy && <span className="helper-spinner" />}
        {!busy && filing.status === null && (
          <button
            className="helper-btn helper-btn-sm"
            onClick={() => onClassify(filing.fileIndexId)}
            title="Suggest where this email belongs"
          >
            Sort
          </button>
        )}
        {!busy && filing.status === 'suggested' && (
          <>
            {filing.suggestedProjectKey && (
              <button
                className="helper-btn helper-btn-sm"
                onClick={() => onAssign(filing.fileIndexId, filing.suggestedProjectKey!)}
                title="File to the suggested project"
              >
                File it
              </button>
            )}
            <select
              className="helper-workspace-select"
              value={choice}
              onChange={(e) => {
                const key = e.target.value;
                setChoice(key);
                if (key) onAssign(filing.fileIndexId, key);
              }}
              title="File to a different project"
            >
              <option value="">Move to…</option>
              {projects.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.key} {p.label}
                </option>
              ))}
            </select>
          </>
        )}
      </div>
    </div>
  );
}

export default function WorkspacePanel({ onClose }: { onClose: () => void }) {
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
    setFilter,
    clearFilter,
  } = useWorkspaceStore();
  const username = useChatStore((s) => s.username);

  const [tab, setTab] = useState<WorkspaceTab>('search');
  const [query, setQuery] = useState('');
  const [openErrorId, setOpenErrorId] = useState<string | null>(null);

  // Debounced search (300 ms). Filter chips re-issue this fetch too — they
  // only ever change the store's `filters`, which this effect already watches.
  useEffect(() => {
    const q = query.trim();
    if (!q) return;
    const timer = setTimeout(() => {
      search(q, filters);
    }, 300);
    return () => clearTimeout(timer);
  }, [query, filters, search]);

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
    browse(sources[0].id, '');
  }, [tab, browsePath, sources, browse]);

  // Not yet wired to a row action — Task 7 hangs this off the ⋯ context menu.
  const handleCopyPath = (file: FinderFile) => {
    const path = file.openPath ?? file.relPath;
    navigator.clipboard.writeText(path).catch(() => {});
    recordActivity(file.id, 'copy_path', username);
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
    setTab('browse');
    browse(file.sourceId, file.parentPath);
  };

  // Browse's Open drills into directories instead of opening them in place.
  const handleBrowseOpen = (file: FinderFile) => {
    if (file.isDir) {
      if (browsePath) browse(browsePath.sourceId, file.relPath);
      return;
    }
    handleOpen(file);
  };

  const activeSource = browsePath ? sources.find((s) => s.id === browsePath.sourceId) : null;
  const crumbSegments = browsePath
    ? browsePath.parentPath.split('/').filter(Boolean)
    : [];

  return (
    <div className="helper-container">
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

      <div className="helper-workspace-tabs">
        <SegmentedControl
          options={[
            { key: 'search', label: 'Search' },
            { key: 'browse', label: 'Browse' },
            { key: 'recents', label: 'Recents' },
            ...(filingEnabled ? [{ key: 'filing', label: 'Filing' }] : []),
          ]}
          value={tab}
          onChange={(key) => setTab(key as WorkspaceTab)}
        />
      </div>

      {error && (
        <div className="helper-error-banner">
          <span>{error}</span>
        </div>
      )}

      {tab === 'search' && (
        <div className="helper-workspace-body">
          <div className="helper-workspace-toolbar">
            <input
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
            {loading && <LoadingRow />}
            {!loading && !query.trim() && (
              <div className="helper-history-empty">
                Search your company's shared files by name.
              </div>
            )}
            {!loading && query.trim() && results.length === 0 && (
              <div className="helper-history-empty">No files matched.</div>
            )}
            {!loading && query.trim() && results.length > 0 && (
              <FileTable
                view="search"
                rows={results}
                onOpen={handleOpen}
                onCopy={handleCopyPath}
                onReveal={handleReveal}
                renderMeta={(file) => renderFileMeta(file, openErrorId === file.id)}
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
                onClick={() => browse(s.id, '')}
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
              <div className="helper-workspace-breadcrumb">
                <button
                  className="helper-workspace-crumb"
                  onClick={() => browse(browsePath.sourceId, '')}
                >
                  {activeSource?.displayName ?? 'Top'}
                </button>
                {crumbSegments.map((seg, i) => (
                  <span key={`${seg}-${i}`}>
                    <span className="helper-workspace-crumb-sep"> / </span>
                    <button
                      className="helper-workspace-crumb"
                      onClick={() =>
                        browse(browsePath.sourceId, crumbSegments.slice(0, i + 1).join('/'))
                      }
                    >
                      {seg}
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="helper-workspace-list">
              {loading && <LoadingRow />}
              {!loading && browsePath && entries.length === 0 && (
                <div className="helper-history-empty">This folder is empty.</div>
              )}
              {!loading && entries.length > 0 && (
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
          <div className="helper-workspace-list">
            {loading && <LoadingRow />}
            {!loading && filings.length === 0 && (
              <div className="helper-history-empty">No unfiled mail right now.</div>
            )}
            {!loading && filings.length > 0 && (
              <>
                <div className="helper-workspace-section-title">Unfiled mail</div>
                {filings.map((filing) => (
                  <FilingRow
                    key={filing.fileIndexId}
                    filing={filing}
                    projects={projects}
                    busy={filingBusy === filing.fileIndexId}
                    onClassify={classifyEmail}
                    onAssign={(id, key) => assignFiling(id, key, username)}
                  />
                ))}
              </>
            )}
          </div>
        </div>
      )}

      {tab === 'recents' && (
        <div className="helper-workspace-body">
          <div className="helper-workspace-list">
            {loading && <LoadingRow />}
            {!loading && (
              <>
                <div className="helper-workspace-section-title">Your recent files</div>
                {recent.length === 0 && (
                  <div className="helper-history-empty">
                    Files you open or copy will show up here.
                  </div>
                )}
                {recent.length > 0 && (
                  <FileTable
                    view="recents"
                    rows={recent}
                    onOpen={handleOpen}
                    onCopy={handleCopyPath}
                    onReveal={handleReveal}
                    renderMeta={(file) => renderFileMeta(file, openErrorId === file.id)}
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
