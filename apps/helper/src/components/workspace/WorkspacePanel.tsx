import { useEffect, useState } from 'react';
import { useWorkspaceStore, type FinderFile } from '../../stores/workspaceStore';
import { useChatStore } from '../../stores/chatStore';

const isMacOS =
  navigator.platform.startsWith('Mac') || navigator.userAgent.includes('Macintosh');

type WorkspaceTab = 'search' | 'browse' | 'recents';

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

function FileRow({
  file,
  sourceName,
  timestamp,
  copied,
  onCopyPath,
  onReveal,
  onOpen,
}: {
  file: FinderFile;
  sourceName?: string;
  timestamp?: string | null;
  copied: boolean;
  onCopyPath: (file: FinderFile) => void;
  onReveal?: (file: FinderFile) => void;
  /** Open-in-place — wired up by the open_workspace_path Tauri command task. */
  onOpen?: (file: FinderFile) => void;
}) {
  const metaParts = [
    sourceName,
    file.parentPath || null,
    formatWhen(timestamp ?? file.mtime),
  ].filter(Boolean);

  return (
    <div className="helper-file-row">
      <div className="helper-file-main">
        <span className="helper-file-name">{file.isDir ? `${file.name}/` : file.name}</span>
        <span className="helper-file-meta">{metaParts.join(' · ')}</span>
      </div>
      <div className="helper-file-actions">
        {copied && <span className="helper-file-copied">Copied</span>}
        {onOpen && file.openPath && (
          <button
            className="helper-btn helper-btn-sm"
            onClick={() => onOpen(file)}
            title="Open this file"
          >
            Open
          </button>
        )}
        <button
          className="helper-btn helper-btn-sm"
          onClick={() => onCopyPath(file)}
          title="Copy the file path"
        >
          Copy
        </button>
        {onReveal && (
          <button
            className="helper-btn helper-btn-sm"
            onClick={() => onReveal(file)}
            title="Show this file's folder in Browse"
          >
            Reveal
          </button>
        )}
      </div>
    </div>
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

export default function WorkspacePanel({ onClose }: { onClose: () => void }) {
  const {
    sources,
    results,
    entries,
    recent,
    department,
    loading,
    error,
    browsePath,
    search,
    browse,
    loadRecents,
    recordActivity,
  } = useWorkspaceStore();
  const username = useChatStore((s) => s.username);

  const [tab, setTab] = useState<WorkspaceTab>('search');
  const [query, setQuery] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const sourceName = (id: string) => sources.find((s) => s.id === id)?.displayName;

  // Debounced search (300 ms).
  useEffect(() => {
    const q = query.trim();
    if (!q) return;
    const timer = setTimeout(() => {
      search(q, sourceFilter ? { sourceId: sourceFilter } : undefined);
    }, 300);
    return () => clearTimeout(timer);
  }, [query, sourceFilter, search]);

  // Load recents when the tab is shown.
  useEffect(() => {
    if (tab === 'recents') loadRecents(username);
  }, [tab, username, loadRecents]);

  // Open the first source when Browse is shown for the first time.
  useEffect(() => {
    if (tab !== 'browse' || browsePath || sources.length === 0) return;
    browse(sources[0].id, '');
  }, [tab, browsePath, sources, browse]);

  const handleCopyPath = (file: FinderFile) => {
    const path = file.openPath ?? file.relPath;
    navigator.clipboard
      .writeText(path)
      .then(() => {
        setCopiedId(file.id);
        setTimeout(() => setCopiedId((cur) => (cur === file.id ? null : cur)), 1500);
      })
      .catch(() => {});
    recordActivity(file.id, 'copy_path', username);
  };

  const handleReveal = (file: FinderFile) => {
    recordActivity(file.id, 'reveal', username);
    setTab('browse');
    browse(file.sourceId, file.parentPath);
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
        {(['search', 'browse', 'recents'] as const).map((t) => (
          <button
            key={t}
            className={`helper-workspace-tab${tab === t ? ' helper-workspace-tab-active' : ''}`}
            onClick={() => setTab(t)}
          >
            {t === 'search' ? 'Search' : t === 'browse' ? 'Browse' : 'Recents'}
          </button>
        ))}
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
            {sources.length > 1 && (
              <select
                value={sourceFilter}
                onChange={(e) => setSourceFilter(e.target.value)}
                className="helper-workspace-select"
                title="Limit search to one source"
              >
                <option value="">All sources</option>
                {sources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.displayName}
                  </option>
                ))}
              </select>
            )}
          </div>
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
            {!loading &&
              query.trim() &&
              results.map((file) => (
                <FileRow
                  key={file.id}
                  file={file}
                  sourceName={sourceName(file.sourceId)}
                  copied={copiedId === file.id}
                  onCopyPath={handleCopyPath}
                  onReveal={handleReveal}
                />
              ))}
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
              {!loading &&
                entries.map((entry) =>
                  entry.isDir ? (
                    <button
                      key={entry.id}
                      className="helper-file-row helper-file-row-dir"
                      onClick={() => browsePath && browse(browsePath.sourceId, entry.relPath)}
                    >
                      <div className="helper-file-main">
                        <span className="helper-file-name">{entry.name}/</span>
                        <span className="helper-file-meta">Folder</span>
                      </div>
                    </button>
                  ) : (
                    <FileRow
                      key={entry.id}
                      file={entry}
                      copied={copiedId === entry.id}
                      onCopyPath={handleCopyPath}
                    />
                  ),
                )}
            </div>
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
                {recent.map((file) => (
                  <FileRow
                    key={file.id}
                    file={file}
                    sourceName={sourceName(file.sourceId)}
                    copied={copiedId === file.id}
                    onCopyPath={handleCopyPath}
                    onReveal={handleReveal}
                  />
                ))}
                <div className="helper-workspace-section-title">
                  Recently active in your company
                </div>
                {department.length === 0 && (
                  <div className="helper-history-empty">Nothing here yet.</div>
                )}
                {department.map((file) => (
                  <FileRow
                    key={file.id}
                    file={file}
                    sourceName={sourceName(file.sourceId)}
                    timestamp={file.lastActivityAt}
                    copied={copiedId === file.id}
                    onCopyPath={handleCopyPath}
                    onReveal={handleReveal}
                  />
                ))}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
