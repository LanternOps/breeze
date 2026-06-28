import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';

export interface SelectOption {
  id: string;
  name: string;
}

interface Props {
  /** Options to search; the picker filters by name (case-insensitive substring). */
  options: SelectOption[];
  /** Currently-selected option id ('' when none). */
  value: string;
  /** Called with the chosen option id. */
  onChange: (id: string) => void;
  placeholder?: string;
  disabled?: boolean;
  testId?: string;
  /** Accessible label when no visible <label> is wired to the input. */
  ariaLabel?: string;
  /** Cap the visible result rows. */
  maxResults?: number;
}

/**
 * Generic searchable single-select (combobox). Mirrors CatalogItemPicker's
 * keyboard + ARIA behaviour but keeps the current selection visible instead of
 * clearing after a pick — use it anywhere a native <select> would force a
 * scroll-hunt through many options (e.g. the org picker on long tenant lists).
 * The dropdown is absolutely positioned within a relative wrapper, so place it
 * in form areas that are not overflow-clipped.
 */
export default function SearchableSelect({
  options,
  value,
  onChange,
  placeholder = 'Search…',
  disabled,
  testId = 'searchable-select',
  ariaLabel,
  maxResults = 8,
}: Props) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const selected = useMemo(() => options.find((o) => o.id === value) ?? null, [options, value]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return options.filter((o) => !q || o.name.toLowerCase().includes(q));
  }, [options, query]);
  const results = useMemo(() => matches.slice(0, maxResults), [matches, maxResults]);
  const truncated = matches.length > results.length;

  useEffect(() => { setActive(0); }, [query, open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) { setOpen(false); setQuery(''); }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const choose = (opt: SelectOption) => {
    onChange(opt.id);
    setQuery('');
    setOpen(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') { setOpen(false); setQuery(''); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, results.length - 1)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); return; }
    if (e.key === 'Enter' && open && results[active]) { e.preventDefault(); choose(results[active]); }
  };

  // Closed: show the selected name. Open: show what the user is typing.
  const display = open ? query : (selected?.name ?? '');

  return (
    <div ref={wrapRef} className="relative" data-testid={testId}>
      <input
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && results.length > 0 ? `${listId}-opt-${active}` : undefined}
        aria-label={ariaLabel}
        value={display}
        disabled={disabled}
        placeholder={selected ? selected.name : placeholder}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        className="h-10 w-full rounded-md border bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
        data-testid={`${testId}-input`}
      />
      {open && results.length > 0 && (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-30 mt-1 max-h-64 w-full overflow-auto rounded-md border bg-card py-1 shadow-lg"
          data-testid={`${testId}-list`}
        >
          {results.map((opt, idx) => (
            <li key={opt.id} id={`${listId}-opt-${idx}`} role="option" aria-selected={idx === active}>
              <button
                type="button"
                onMouseEnter={() => setActive(idx)}
                onClick={() => choose(opt)}
                className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm ${idx === active ? 'bg-muted' : ''} ${opt.id === value ? 'font-medium' : ''}`}
                data-testid={`${testId}-option-${opt.id}`}
              >
                <span className="flex-1 truncate">{opt.name}</span>
                {opt.id === value && <span className="text-primary" aria-hidden="true">✓</span>}
              </button>
            </li>
          ))}
          {truncated && (
            <li
              className="border-t px-3 py-1.5 text-[11px] text-muted-foreground"
              role="presentation"
              data-testid={`${testId}-truncated`}
            >
              Showing {results.length} of {matches.length} — keep typing to narrow.
            </li>
          )}
        </ul>
      )}
      {open && query.trim() !== '' && results.length === 0 && (
        <div
          className="absolute z-30 mt-1 w-full rounded-md border bg-card px-3 py-2 text-xs text-muted-foreground shadow-lg"
          data-testid={`${testId}-noresults`}
        >
          No matches.
        </div>
      )}
    </div>
  );
}
