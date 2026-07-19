import { useEffect, useRef, useState } from 'react';
import type { FinderFile, WorkspaceFilters, WorkspaceSource } from '../../stores/workspaceStore';

type ChipKey = 'project' | 'docType' | 'date' | 'sourceId' | 'kind';

const CHIP_LABELS: Record<ChipKey, string> = {
  project: 'Project',
  docType: 'Doc type',
  date: 'Date',
  sourceId: 'Source',
  kind: 'Kind',
};

const DATE_PRESETS: Array<{ label: string; days: number }> = [
  { label: 'Last 7 days', days: 7 },
  { label: 'Last 30 days', days: 30 },
];

function isoDateDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

/** Distinct, sorted, non-empty values of a field across the currently loaded rows. */
function distinctValues(rows: FinderFile[], pick: (f: FinderFile) => string | null | undefined): string[] {
  const values = new Set<string>();
  for (const row of rows) {
    const value = pick(row);
    if (value) values.add(value);
  }
  return [...values].sort((a, b) => a.localeCompare(b));
}

function dateChipLabel(filters: WorkspaceFilters): string | null {
  if (filters.dateFrom && filters.dateTo) return `${filters.dateFrom} – ${filters.dateTo}`;
  if (filters.dateFrom) return `Since ${filters.dateFrom}`;
  if (filters.dateTo) return `Until ${filters.dateTo}`;
  return null;
}

export interface FilterChipsProps {
  /** Currently loaded rows — the source for the Project/Doc type/Kind option lists. */
  rows: FinderFile[];
  sources: WorkspaceSource[];
  filters: WorkspaceFilters;
  onSetFilter: <K extends keyof WorkspaceFilters>(key: K, value: WorkspaceFilters[K]) => void;
  onClearFilter: (key: keyof WorkspaceFilters) => void;
}

/**
 * Chip row for the Search toolbar: Project, Doc type, Date, Source, Kind.
 * Each chip opens a plain positioned listbox — a placeholder for the Radix
 * DropdownMenu Task 7 swaps in once that dependency lands.
 */
export function FilterChips({ rows, sources, filters, onSetFilter, onClearFilter }: FilterChipsProps) {
  const [open, setOpen] = useState<ChipKey | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(null);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const select = (key: keyof WorkspaceFilters, value: string) => {
    onSetFilter(key, value);
    setOpen(null);
  };

  const projectValues = distinctValues(rows, (f) => f.inferredProjectLabel);
  const docTypeValues = distinctValues(rows, (f) => f.inferredDocType);
  const kindValues = distinctValues(rows, (f) => f.ext);

  function chip(
    key: ChipKey,
    activeLabel: string | null,
    onClear: () => void,
    menu: React.ReactNode,
  ) {
    const active = activeLabel !== null;
    return (
      <div className="ws-filter-chip-wrap" key={key}>
        <button
          type="button"
          className={`ws-filter-chip${active ? ' ws-filter-chip-active' : ''}`}
          onClick={() => setOpen(open === key ? null : key)}
          aria-expanded={open === key}
        >
          <span>{active ? `${CHIP_LABELS[key]}: ${activeLabel}` : CHIP_LABELS[key]}</span>
          {active && (
            <span
              className="ws-filter-chip-close"
              role="button"
              tabIndex={0}
              aria-label={`Clear ${CHIP_LABELS[key]} filter`}
              onClick={(e) => {
                e.stopPropagation();
                onClear();
                setOpen(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  e.stopPropagation();
                  onClear();
                  setOpen(null);
                }
              }}
            >
              ✕
            </span>
          )}
        </button>
        {open === key && <div className="ws-filter-chip-menu">{menu}</div>}
      </div>
    );
  }

  function optionList(values: string[], onPick: (v: string) => void) {
    if (values.length === 0) {
      return <div className="ws-filter-chip-menu-empty">No values in the current results</div>;
    }
    return values.map((v) => (
      <button key={v} type="button" className="ws-filter-chip-menu-item" onClick={() => onPick(v)}>
        {v}
      </button>
    ));
  }

  return (
    <div className="ws-filter-chip-row" ref={containerRef}>
      {chip(
        'project',
        filters.project ?? null,
        () => onClearFilter('project'),
        optionList(projectValues, (v) => select('project', v)),
      )}
      {chip(
        'docType',
        filters.docType ?? null,
        () => onClearFilter('docType'),
        optionList(docTypeValues, (v) => select('docType', v)),
      )}
      {chip(
        'date',
        dateChipLabel(filters),
        () => {
          onClearFilter('dateFrom');
          onClearFilter('dateTo');
        },
        <div className="ws-filter-chip-menu-date">
          {DATE_PRESETS.map((preset) => (
            <button
              key={preset.label}
              type="button"
              className="ws-filter-chip-menu-item"
              onClick={() => {
                onSetFilter('dateFrom', isoDateDaysAgo(preset.days));
                onClearFilter('dateTo');
                setOpen(null);
              }}
            >
              {preset.label}
            </button>
          ))}
          <div className="ws-filter-chip-menu-custom">
            <label>
              From
              <input
                type="date"
                value={filters.dateFrom?.slice(0, 10) ?? ''}
                onChange={(e) => onSetFilter('dateFrom', e.target.value)}
              />
            </label>
            <label>
              To
              <input
                type="date"
                value={filters.dateTo?.slice(0, 10) ?? ''}
                onChange={(e) => onSetFilter('dateTo', e.target.value)}
              />
            </label>
          </div>
        </div>,
      )}
      {sources.length > 1 && chip(
        'sourceId',
        sources.find((s) => s.id === filters.sourceId)?.displayName ?? null,
        () => onClearFilter('sourceId'),
        sources.map((s) => (
          <button
            key={s.id}
            type="button"
            className="ws-filter-chip-menu-item"
            onClick={() => select('sourceId', s.id)}
          >
            {s.displayName}
          </button>
        )),
      )}
      {chip(
        'kind',
        filters.kind ?? null,
        () => onClearFilter('kind'),
        optionList(kindValues, (v) => select('kind', v)),
      )}
    </div>
  );
}
