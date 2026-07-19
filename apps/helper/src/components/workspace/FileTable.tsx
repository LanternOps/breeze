import type { ReactNode } from 'react';
import {
  useWorkspaceStore, sortRows, type FinderFile, type SortCol, type View,
} from '../../stores/workspaceStore';

const COLUMNS: Array<{ key: SortCol; label: string }> = [
  { key: 'name', label: 'Name' },
  { key: 'project', label: 'Project' },
  { key: 'docType', label: 'Doc type' },
  { key: 'mtime', label: 'Modified' },
  { key: 'size', label: 'Size' },
];

function formatSize(bytes: number | null): string {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let n = bytes / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

function formatModified(mtime: string | null): string {
  if (!mtime) return '';
  const d = new Date(mtime);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export interface FileTableProps {
  view: View;
  rows: FinderFile[];
  /** Opens a file, or — in Browse — drills into a directory. */
  onOpen: (file: FinderFile) => void;
  /**
   * Copy-path / reveal-in-Browse. Not yet exposed by this table's own UI —
   * the row actions this task ships are a temporary hover Open button only.
   * Tasks 7-8 wire these into the hover ⋯ context menu and keyboard model.
   */
  onCopy: (file: FinderFile) => void;
  onReveal?: (file: FinderFile) => void;
  /** Optional second line under the file name — snippet, mismatch banner, etc. */
  renderMeta?: (file: FinderFile) => ReactNode;
}

/** Sortable list-table for the search/browse/recents file views. */
export function FileTable(props: FileTableProps) {
  const { view, rows, onOpen, renderMeta } = props;
  const sort = useWorkspaceStore((s) => s.sort[view]);
  const setSort = useWorkspaceStore((s) => s.setSort);
  const sorted = sortRows(rows, sort, { dirsFirst: view === 'browse' });

  return (
    <div className="ws-file-table" role="table">
      <div className="ws-file-table-header" role="row">
        {COLUMNS.map((col) => (
          <button
            key={col.key}
            type="button"
            className="ws-file-table-colbtn"
            onClick={() => setSort(view, col.key)}
            aria-sort={sort?.col === col.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
          >
            <span>{col.label}</span>
            {sort?.col === col.key && (
              <span className="ws-file-table-chevron">{sort.dir === 'asc' ? '▲' : '▼'}</span>
            )}
          </button>
        ))}
      </div>
      <div className="ws-file-table-body" role="rowgroup">
        {sorted.map((file) => {
          const meta = renderMeta?.(file);
          return (
            <div key={file.id} className="ws-file-table-row" role="row">
              <div className="ws-file-table-cell ws-file-table-name-cell">
                <span className="ws-file-table-name" title={file.relPath}>
                  {file.isDir ? `${file.name}/` : file.name}
                </span>
                {meta != null && <div className="ws-file-table-meta">{meta}</div>}
              </div>
              <div className="ws-file-table-cell ws-file-table-secondary">
                {file.inferredProjectLabel ?? ''}
              </div>
              <div className="ws-file-table-cell ws-file-table-secondary">
                {file.inferredDocType ?? ''}
              </div>
              <div className="ws-file-table-cell ws-file-table-tertiary ws-tabular">
                {formatModified(file.mtime)}
              </div>
              <div className="ws-file-table-cell ws-file-table-tertiary ws-tabular">
                {file.isDir ? '' : formatSize(file.size)}
              </div>
              {(file.isDir || file.openPath) && (
                <button
                  type="button"
                  className="ws-file-table-open"
                  onClick={() => onOpen(file)}
                  title={file.isDir ? 'Open this folder' : 'Open this file'}
                >
                  Open
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
