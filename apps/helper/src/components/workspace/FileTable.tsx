import { useEffect, useRef, type ReactNode } from 'react';
import {
  useWorkspaceStore, sortRows,
  type FinderFile, type SortCol, type View, type WorkspaceSource,
} from '../../stores/workspaceStore';
import { RowMenu, type MenuItem } from '../ui/RowMenu';
import { useListSelection } from '../../lib/useListSelection';

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
  /** Copies the file's path to the clipboard (row menu: "Copy path"). */
  onCopy: (file: FinderFile) => void;
  /** Reveals the file's folder in Browse (row menu: "Reveal in Browse"). Omitted in Browse itself. */
  onReveal?: (file: FinderFile) => void;
  /** Optional second line under the file name — snippet, mismatch banner, etc. */
  renderMeta?: (file: FinderFile) => ReactNode;
  /**
   * All configured sources. When more than one is configured, a small
   * initial badge renders next to the file name (tooltip = full display
   * name) so multi-share results stay distinguishable — the row's second
   * line is reserved for snippet/mismatch/open-error content only, so this
   * lives inline with the name instead. Single-source setups render nothing.
   */
  sources?: WorkspaceSource[];
}

function sourceLabel(file: FinderFile, sources: WorkspaceSource[]): string {
  return sources.find((s) => s.id === file.sourceId)?.displayName ?? file.sourceId;
}

/**
 * Directory rows: Open in Browse only. File rows: Open, Copy path, and
 * (when the view supports it) Reveal in Browse.
 */
function rowMenuItems(
  file: FinderFile,
  { onOpen, onCopy, onReveal }: Pick<FileTableProps, 'onOpen' | 'onCopy' | 'onReveal'>,
): MenuItem[] {
  if (file.isDir) {
    return [{ label: 'Open', onSelect: () => onOpen(file) }];
  }
  const items: MenuItem[] = [
    { label: 'Open', onSelect: () => onOpen(file), disabled: !file.openPath },
    { label: 'Copy path', onSelect: () => onCopy(file) },
  ];
  if (onReveal) {
    items.push({ label: 'Reveal in Browse', onSelect: () => onReveal(file) });
  }
  return items;
}

/** Sortable list-table for the search/browse/recents file views. */
export function FileTable(props: FileTableProps) {
  const { view, rows, onOpen, onCopy, onReveal, renderMeta, sources } = props;
  const sort = useWorkspaceStore((s) => s.sort[view]);
  const setSort = useWorkspaceStore((s) => s.setSort);
  const sorted = sortRows(rows, sort, { dirsFirst: view === 'browse' });
  const showSource = (sources?.length ?? 0) > 1;

  const rowRefs = useRef<Array<HTMLDivElement | null>>([]);
  const { selected, onKeyDown } = useListSelection(sorted.length, {
    onActivate: (i) => {
      const file = sorted[i];
      if (file) onOpen(file);
    },
    onCopy: (i) => {
      const file = sorted[i];
      if (file) onCopy(file);
    },
  });

  // Keep the selected row in view as Arrow Up/Down move it.
  useEffect(() => {
    if (selected === null) return;
    rowRefs.current[selected]?.scrollIntoView?.({ block: 'nearest' });
  }, [selected]);

  // Escape clears an active row selection without walking the panel back —
  // only let it bubble to WorkspacePanel's Back handler once there's nothing
  // left in this table to clear.
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && selected !== null) e.stopPropagation();
    onKeyDown(e);
  };

  return (
    <div className="ws-file-table" role="table" tabIndex={0} onKeyDown={handleKeyDown}>
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
        {sorted.map((file, i) => {
          const meta = renderMeta?.(file);
          const isSelected = selected === i;
          return (
            <RowMenu key={file.id} items={rowMenuItems(file, { onOpen, onCopy, onReveal })}>
              <div
                ref={(el) => {
                  rowRefs.current[i] = el;
                }}
                className={`ws-file-table-row${isSelected ? ' ws-row-selected' : ''}`}
                role="row"
                aria-selected={isSelected}
                onDoubleClick={() => onOpen(file)}
              >
                <div className="ws-file-table-cell ws-file-table-name-cell">
                  <div className="ws-file-table-name-row">
                    <span className="ws-file-table-name" title={file.relPath}>
                      {file.isDir ? `${file.name}/` : file.name}
                    </span>
                    {showSource && (
                      <span
                        className="ws-file-table-source"
                        title={sourceLabel(file, sources!)}
                      >
                        {sourceLabel(file, sources!).slice(0, 1).toUpperCase()}
                      </span>
                    )}
                  </div>
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
              </div>
            </RowMenu>
          );
        })}
      </div>
    </div>
  );
}
