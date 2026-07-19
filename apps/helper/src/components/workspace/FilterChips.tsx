import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import type { FinderFile, WorkspaceFilters, WorkspaceSource } from '../../stores/workspaceStore';

export type ChipKey = 'project' | 'docType' | 'date' | 'sourceId' | 'kind';

const ALL_CHIPS: ChipKey[] = ['project', 'docType', 'date', 'sourceId', 'kind'];

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
  /**
   * Which chips to render, in order. Defaults to all five (Search toolbar).
   * Browse passes just `['project', 'docType']` — the only two params the
   * browse endpoint accepts (see the Architecture note authorizing them
   * there); Date/Source/Kind stay Search-only.
   */
  chips?: ChipKey[];
}

/** Chip row: Project, Doc type, Date, Source, Kind — each a Radix DropdownMenu; `chips` narrows which render. */
export function FilterChips({
  rows, sources, filters, onSetFilter, onClearFilter, chips = ALL_CHIPS,
}: FilterChipsProps) {
  const enabled = new Set(chips);
  function chip(
    key: ChipKey,
    activeLabel: string | null,
    onClear: () => void,
    menu: React.ReactNode,
  ) {
    const active = activeLabel !== null;
    return (
      <DropdownMenu.Root key={key}>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            className={`ws-filter-chip${active ? ' ws-filter-chip-active' : ''}`}
          >
            <span>{active ? `${CHIP_LABELS[key]}: ${activeLabel}` : CHIP_LABELS[key]}</span>
            {active && (
              <span
                className="ws-filter-chip-close"
                role="button"
                tabIndex={0}
                aria-label={`Clear ${CHIP_LABELS[key]} filter`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onClear();
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    e.stopPropagation();
                    onClear();
                  }
                }}
              >
                ✕
              </span>
            )}
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="ws-filter-chip-menu" align="start" sideOffset={4}>
            {menu}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    );
  }

  function optionList(values: string[], onPick: (v: string) => void) {
    if (values.length === 0) {
      return <div className="ws-filter-chip-menu-empty">No values in the current results</div>;
    }
    return values.map((v) => (
      <DropdownMenu.Item key={v} className="ws-filter-chip-menu-item" onSelect={() => onPick(v)}>
        {v}
      </DropdownMenu.Item>
    ));
  }

  const projectValues = distinctValues(rows, (f) => f.inferredProjectLabel);
  const docTypeValues = distinctValues(rows, (f) => f.inferredDocType);
  const kindValues = distinctValues(rows, (f) => f.ext);

  return (
    <div className="ws-filter-chip-row">
      {enabled.has('project') && chip(
        'project',
        filters.project ?? null,
        () => onClearFilter('project'),
        optionList(projectValues, (v) => onSetFilter('project', v)),
      )}
      {enabled.has('docType') && chip(
        'docType',
        filters.docType ?? null,
        () => onClearFilter('docType'),
        optionList(docTypeValues, (v) => onSetFilter('docType', v)),
      )}
      {enabled.has('date') && chip(
        'date',
        dateChipLabel(filters),
        () => {
          onClearFilter('dateFrom');
          onClearFilter('dateTo');
        },
        <div className="ws-filter-chip-menu-date">
          {DATE_PRESETS.map((preset) => (
            <DropdownMenu.Item
              key={preset.label}
              className="ws-filter-chip-menu-item"
              onSelect={() => {
                onSetFilter('dateFrom', isoDateDaysAgo(preset.days));
                onClearFilter('dateTo');
              }}
            >
              {preset.label}
            </DropdownMenu.Item>
          ))}
          <div
            className="ws-filter-chip-menu-custom"
            onKeyDownCapture={(e) => {
              // Radix Menu.Content's onKeyDown unconditionally preventDefaults Tab
              // for any keydown originating inside [data-radix-menu-content] (no
              // focus-trap boundary check, unlike react-focus-scope). That leaves
              // Tab non-functional between these two plain <input>s, which aren't
              // registered Menu.Items and so get no arrow-key roving focus either.
              // Stop the event here, in capture phase, before it reaches Content's
              // bubble-phase handler, so native Tab focus movement is preserved.
              if (e.key === 'Tab') e.stopPropagation();
            }}
          >
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
      {enabled.has('sourceId') && sources.length > 1 && chip(
        'sourceId',
        sources.find((s) => s.id === filters.sourceId)?.displayName ?? null,
        () => onClearFilter('sourceId'),
        sources.map((s) => (
          <DropdownMenu.Item
            key={s.id}
            className="ws-filter-chip-menu-item"
            onSelect={() => onSetFilter('sourceId', s.id)}
          >
            {s.displayName}
          </DropdownMenu.Item>
        )),
      )}
      {enabled.has('kind') && chip(
        'kind',
        filters.kind ?? null,
        () => onClearFilter('kind'),
        optionList(kindValues, (v) => onSetFilter('kind', v)),
      )}
    </div>
  );
}
