import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronUp, Columns3, RotateCcw, Search } from 'lucide-react';

import {
  COLUMN_GROUP_ORDER,
  COLUMN_GROUPS,
  COLUMN_LABELS,
  isColumnLocked,
  type ColumnId,
} from './columnVisibility';

/**
 * Why the class segment currently keeps a column off the table. The chooser
 * shows the reason instead of a checked box for a column that is not drawn.
 */
export type ColumnGateReason = 'agentOnlyFleet' | 'networkOnlyView' | 'noManualAssets';

export interface ColumnChooserCustomField {
  id: string;
  fieldKey: string;
  name: string;
}

export interface ColumnChooserProps {
  columnOrder: ReadonlyArray<ColumnId>;
  visibleColumns: ReadonlySet<ColumnId>;
  /** False for a column that does not apply to this surface at all (it is not listed). */
  isColumnAvailable: (id: ColumnId) => boolean;
  /** Non-null when the classes on screen keep the column off the table. */
  gateReason: (id: ColumnId) => ColumnGateReason | null;
  onToggle: (id: ColumnId) => void;
  onMove: (id: ColumnId, direction: -1 | 1) => void;
  onReset: () => void;
  customFieldDefinitions: ReadonlyArray<ColumnChooserCustomField>;
  visibleCustomFieldKeys: ReadonlySet<string>;
  onToggleCustomField: (fieldKey: string) => void;
}

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

const groupHeadingClass =
  'px-2 pb-0.5 pt-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground';

/**
 * The devices list "Columns" popover (#9034): a non-modal dialog with a filter
 * box, the shown columns in render order (reorderable), and the rest grouped
 * by section. Escape closes it and refocuses the trigger; an outside click
 * closes it and refocuses the trigger only if focus would otherwise be lost.
 * Non-modal (aria-modal=false: the page stays live) but Tab wraps inside.
 */
export function ColumnChooser({
  columnOrder,
  visibleColumns,
  isColumnAvailable,
  gateReason,
  onToggle,
  onMove,
  onReset,
  customFieldDefinitions,
  visibleCustomFieldKeys,
  onToggleCustomField,
}: ColumnChooserProps) {
  const { t } = useTranslation('devices');
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const panelId = useId();
  const headingId = useId();

  const close = useCallback((returnFocus: 'always' | 'ifLost') => {
    setOpen(false);
    setQuery('');
    if (returnFocus === 'always') {
      triggerRef.current?.focus();
      return;
    }
    // An outside click on something focusable keeps that focus; a click on
    // inert space would otherwise strand focus on <body> once the panel goes.
    // A 0ms timeout suffices: the mousedown's default focus move has run by then.
    setTimeout(() => {
      const active = document.activeElement;
      if (!active || active === document.body) triggerRef.current?.focus();
    }, 0);
  }, []);

  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    const onMouseDown = (event: MouseEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      close('ifLost');
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [open, close]);

  const onPanelKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close('always');
      return;
    }
    if (event.key !== 'Tab' || !panelRef.current) return;
    const focusables = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const needle = query.trim().toLowerCase();
  const matches = (label: string) => needle === '' || label.toLowerCase().includes(needle);

  const listed = columnOrder.filter((id) => isColumnAvailable(id));
  // Drawn on the table right now: in the user's order, reorderable.
  const shown = listed.filter((id) => visibleColumns.has(id) && gateReason(id) === null);
  // Everything else: not chosen, or chosen but gated off by the class segment.
  const rest = listed.filter((id) => !shown.includes(id));

  const shownMatches = shown.filter((id) => matches(COLUMN_LABELS[id]));
  const groups = COLUMN_GROUP_ORDER.map((group) => ({
    group,
    ids: rest.filter((id) => COLUMN_GROUPS[id] === group && matches(COLUMN_LABELS[id])),
  })).filter((g) => g.ids.length > 0);
  const customMatches = customFieldDefinitions.filter((def) => matches(def.name));
  const nothingMatches = shownMatches.length === 0 && groups.length === 0 && customMatches.length === 0;

  const renderShown = (id: ColumnId) => {
    const label = COLUMN_LABELS[id];
    const locked = isColumnLocked(id);
    const idx = shown.indexOf(id);
    return (
      <div
        key={id}
        data-testid={`column-chooser-option-${id}`}
        className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted"
      >
        <input
          type="checkbox"
          checked
          disabled={locked}
          onChange={() => {
            if (!locked) onToggle(id);
          }}
          className="h-4 w-4 rounded border-border disabled:cursor-not-allowed"
          aria-label={locked ? label : t('deviceList.columnChooser.hideColumn', { column: label })}
        />
        <span className="flex min-w-0 flex-1 cursor-default flex-col">
          <span className="truncate">{label}</span>
          {locked && (
            <span className="text-xs text-muted-foreground">{t('deviceList.columnChooser.alwaysShown')}</span>
          )}
        </span>
        <button
          type="button"
          disabled={idx === 0}
          onClick={() => onMove(id, -1)}
          className="rounded p-0.5 hover:bg-background disabled:cursor-not-allowed disabled:opacity-30"
          aria-label={t('deviceList.columnChooser.moveColumnUp', { column: label })}
          title={t('deviceList.moveUp')}
        >
          <ChevronUp className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          disabled={idx === shown.length - 1}
          onClick={() => onMove(id, 1)}
          className="rounded p-0.5 hover:bg-background disabled:cursor-not-allowed disabled:opacity-30"
          aria-label={t('deviceList.columnChooser.moveColumnDown', { column: label })}
          title={t('deviceList.moveDown')}
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  };

  const renderRest = (id: ColumnId) => {
    const label = COLUMN_LABELS[id];
    const reason = gateReason(id);
    return (
      <label
        key={id}
        data-testid={`column-chooser-option-${id}`}
        className={
          reason
            ? 'flex cursor-not-allowed items-start gap-2 rounded px-2 py-1.5 text-sm text-muted-foreground'
            : 'flex cursor-pointer items-start gap-2 rounded px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground'
        }
      >
        <input
          type="checkbox"
          checked={false}
          disabled={reason !== null}
          onChange={() => onToggle(id)}
          className="mt-0.5 h-4 w-4 rounded border-border disabled:cursor-not-allowed"
          aria-label={t('deviceList.columnChooser.showColumn', { column: label })}
        />
        <span className="flex min-w-0 flex-col">
          <span>{label}</span>
          {reason && (
            <span className="text-xs">{t(/* i18n-dynamic */ `deviceList.columnChooser.gate.${reason}`)}</span>
          )}
        </span>
      </label>
    );
  };

  return (
    <div className="relative" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        data-testid="column-chooser-trigger"
        onClick={() => (open ? close('always') : setOpen(true))}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        className="flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md border px-3 text-sm font-medium hover:bg-muted"
      >
        <Columns3 className="h-3.5 w-3.5" />
        {t('deviceList.columns')}
      </button>
      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-modal="false"
          aria-labelledby={headingId}
          data-testid="column-chooser"
          onKeyDown={onPanelKeyDown}
          className="absolute right-0 z-20 mt-1 flex max-h-[28rem] w-80 max-w-[calc(100vw-2rem)] flex-col rounded-md border bg-card shadow-md"
        >
          <div className="border-b p-2">
            <h2 id={headingId} className="px-1 pb-1.5 text-sm font-semibold">
              {t('deviceList.columnChooser.title')}
            </h2>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                ref={searchRef}
                type="search"
                data-testid="column-chooser-search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label={t('deviceList.columnChooser.searchLabel')}
                placeholder={t('deviceList.columnChooser.searchPlaceholder')}
                className="h-8 w-full rounded-md border bg-background pl-7 pr-2 text-sm"
              />
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-1">
            {nothingMatches && (
              <p data-testid="column-chooser-no-matches" className="px-2 py-3 text-sm text-muted-foreground">
                {t('deviceList.columnChooser.noMatches', { query: query.trim() })}
              </p>
            )}
            {shownMatches.length > 0 && (
              <div role="group" aria-labelledby={`${headingId}-shown`} data-testid="column-chooser-shown">
                <h3 id={`${headingId}-shown`} className={groupHeadingClass}>
                  {t('deviceList.visibleInOrder')}
                </h3>
                {shownMatches.map(renderShown)}
              </div>
            )}
            {groups.map(({ group, ids }) => (
              <div
                key={group}
                role="group"
                aria-labelledby={`${headingId}-${group}`}
                data-testid={`column-chooser-group-${group}`}
                className="mt-1 border-t pt-1"
              >
                <h3 id={`${headingId}-${group}`} className={groupHeadingClass}>
                  {t(/* i18n-dynamic */ `deviceList.columnChooser.groups.${group}`)}
                </h3>
                {ids.map(renderRest)}
              </div>
            ))}
            {customMatches.length > 0 && (
              <div
                role="group"
                aria-labelledby={`${headingId}-custom`}
                data-testid="column-chooser-group-custom"
                className="mt-1 border-t pt-1"
              >
                <h3 id={`${headingId}-custom`} className={groupHeadingClass}>
                  {t('deviceList.customFields')}
                </h3>
                {customMatches.map((def) => (
                  <label
                    key={def.id}
                    className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted"
                  >
                    <input
                      type="checkbox"
                      data-testid={`custom-column-toggle-${def.fieldKey}`}
                      checked={visibleCustomFieldKeys.has(def.fieldKey)}
                      onChange={() => onToggleCustomField(def.fieldKey)}
                      className="h-4 w-4 rounded border-border"
                    />
                    <span>{def.name}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
          <div className="border-t p-1">
            <button
              type="button"
              data-testid="column-chooser-reset"
              onClick={onReset}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              {t('deviceList.resetToDefaults')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
