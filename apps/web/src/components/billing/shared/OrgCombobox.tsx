// Typeahead organization picker — a select-shaped combobox for surfaces where a
// native <select> stops scaling (an MSP with 150 orgs gets an unsearchable
// browser list, with long names readable only via a hover tooltip). The trigger
// shows the current org as real, truncating text; opening it reveals a search
// input over a filtered listbox. Modeled on CatalogItemPicker's ARIA pattern.
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import '../../../lib/i18n';

export interface OrgComboboxOption {
  id: string;
  name: string;
}

interface Props {
  options: OrgComboboxOption[];
  /** Selected org id — must be present in `options` (callers prepend it). */
  value: string;
  onSelect: (id: string) => void;
  disabled?: boolean;
  /** Accessible name for the trigger (e.g. "Customer"). */
  label: string;
  /** Trigger look: 'seamless' for the header meta line (borderless until
   *  hover/focus), 'field' for form rows (always-bordered input look). */
  variant?: 'seamless' | 'field';
  testId: string;
}

const MAX_RESULTS = 50;

export function OrgCombobox({ options, value, onSelect, disabled, label, variant = 'field', testId }: Props) {
  const { t } = useTranslation('billing');
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const selected = options.find((o) => o.id === value);

  const { results, truncated } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = options.filter((o) => !q || o.name.toLowerCase().includes(q));
    // Truncation must be ANNOUNCED (see the cap-note row below): an org past
    // position 50 silently missing from the browse list reads as "not a valid
    // target" — the exact failure this component exists to prevent.
    return { results: matches.slice(0, MAX_RESULTS), truncated: matches.length > MAX_RESULTS };
  }, [options, query]);

  useEffect(() => { setActive(0); }, [query]);
  // Focus lands in the search field on open; the list resets to the top.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    searchRef.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const choose = (id: string) => {
    setOpen(false);
    triggerRef.current?.focus();
    onSelect(id);
  };

  const onSearchKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') { e.preventDefault(); setOpen(false); triggerRef.current?.focus(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); return; }
    if (e.key === 'Enter' && results[active]) { e.preventDefault(); choose(results[active].id); }
  };

  const triggerLook =
    variant === 'seamless'
      ? 'h-7 max-w-72 gap-1 rounded-md border border-transparent bg-transparent px-1.5 text-sm text-muted-foreground hover:border-border focus:border-border'
      : 'h-9 w-full gap-2 rounded-md border bg-background px-3 text-sm';

  return (
    <div ref={wrapRef} className={`relative ${variant === 'field' ? 'w-full' : 'min-w-0'}`} data-testid={testId}>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-haspopup="listbox"
        aria-label={label}
        title={selected?.name}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setOpen(true); }
        }}
        data-testid={`${testId}-trigger`}
        className={`inline-flex min-w-0 items-center transition-colors focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 ${triggerLook}`}
      >
        <span className="min-w-0 flex-1 truncate text-left">{selected?.name ?? ''}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 w-72 max-w-[80vw] rounded-md border bg-card shadow-lg" data-testid={`${testId}-popover`}>
          <div className="border-b p-1.5">
            <input
              ref={searchRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onSearchKeyDown}
              placeholder={t('billingUi.orgCombobox.searchPlaceholder')}
              aria-label={t('billingUi.orgCombobox.searchPlaceholder')}
              aria-controls={listId}
              aria-autocomplete="list"
              data-testid={`${testId}-search`}
              className="h-8 w-full rounded-sm border-0 bg-transparent px-2 text-sm focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
          {truncated && (
            <p className="border-b px-3 py-1.5 text-xs text-muted-foreground" data-testid={`${testId}-cap-note`}>
              {t('billingUi.orgCombobox.capNote', { count: MAX_RESULTS })}
            </p>
          )}
          {results.length > 0 ? (
            <ul id={listId} role="listbox" aria-label={label} className="max-h-64 overflow-auto py-1" data-testid={`${testId}-list`}>
              {results.map((o, idx) => (
                <li key={o.id} role="option" aria-selected={o.id === value}>
                  <button
                    type="button"
                    tabIndex={-1}
                    onMouseEnter={() => setActive(idx)}
                    onClick={() => choose(o.id)}
                    title={o.name}
                    data-testid={`${testId}-option-${o.id}`}
                    className={`block w-full truncate px-3 py-1.5 text-left text-sm ${idx === active ? 'bg-muted' : ''} ${o.id === value ? 'font-medium' : ''}`}
                  >
                    {o.name}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-3 py-2 text-xs text-muted-foreground" data-testid={`${testId}-noresults`}>
              {t('billingUi.orgCombobox.noResults')}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export default OrgCombobox;
