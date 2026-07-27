// Typeahead organization picker — a select-shaped disclosure for surfaces where
// a native <select> stops scaling: an MSP with 150 orgs gets an unsearchable
// browser list. Long names still truncate to a `title` tooltip, same as before;
// what changes is that the list became searchable. The trigger shows the current
// org as real text that truncates; opening it reveals a search input over a
// filtered listbox.
//
// ARIA shape: this is NOT CatalogItemPicker's inline-input combobox — the
// trigger has to show the selected org at rest, so the text input lives inside
// the popup. The combobox role therefore belongs to the SEARCH INPUT (the
// element that actually holds focus while the user types and arrows), not to the
// trigger, which is a plain disclosure button. Arrow keys move
// `aria-activedescendant` across options whose `aria-selected` tracks the
// keyboard cursor — the committed org is conveyed by the trigger's own
// accessible name, not by aria-selected. Getting this backwards (aria-selected
// on the committed value, no activedescendant) makes arrow navigation
// completely silent to assistive tech, which on the quote header means
// committing a customer reassignment the user was never told about.
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
  /** Selected org id — must be present in `options`. Build the array with
   *  `orgComboboxOptions()` below, which guarantees it. */
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

/**
 * Builds an options array that satisfies the `value ∈ options` invariant: sorts
 * by name and prepends the selected org when the caller's list doesn't contain
 * it (an All-orgs scope that hasn't loaded it, a cross-partner quote, ...).
 *
 * This exists as a function because both call sites had hand-rolled the same
 * six-line prepend, each ending in an `as` cast that fabricated a partial
 * Organization to satisfy the array's element type. Mapping down to `{id, name}`
 * is what removes the need for the cast — the wide type was never wanted here.
 */
export function orgComboboxOptions(
  orgs: readonly { id: string; name: string }[],
  selectedId: string,
  selectedFallbackName: string,
): OrgComboboxOption[] {
  const sorted = orgs
    .map((o) => ({ id: o.id, name: o.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return sorted.some((o) => o.id === selectedId)
    ? sorted
    : [{ id: selectedId, name: selectedFallbackName }, ...sorted];
}

export function OrgCombobox({ options, value, onSelect, disabled, label, variant = 'field', testId }: Props) {
  const { t } = useTranslation('billing');
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const capNoteId = useId();
  const optionId = (id: string) => `${listId}-opt-${id}`;

  const selected = options.find((o) => o.id === value);

  const { results, truncated } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = options.filter((o) => !q || o.name.toLowerCase().includes(q));
    // Truncation must be ANNOUNCED, not merely drawn: an org past position 50
    // silently missing from the browse list reads as "not a valid target" — the
    // exact failure this component exists to prevent. Focus sits in the search
    // field, so the cap note is wired to its aria-describedby below; a bare <p>
    // beside it would never reach a screen-reader user.
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
      {/* A disclosure button, not the combobox — the combobox is the search
          input this opens (see the ARIA note at the top of the file). */}
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
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
        {/* Falling back to the raw id is deliberately ugly: a blank trigger is
            indistinguishable from "no customer", so a violated `value ∈ options`
            invariant should look broken rather than look empty. */}
        <span className="min-w-0 flex-1 truncate text-left">{selected?.name ?? value}</span>
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
              role="combobox"
              aria-expanded
              // Only reference ids that are actually in the DOM: the list is not
              // rendered on a no-match query, and a dangling aria-controls on an
              // expanded combobox is worse than none.
              aria-controls={results.length > 0 ? listId : undefined}
              aria-activedescendant={results[active] ? optionId(results[active].id) : undefined}
              aria-describedby={truncated ? capNoteId : undefined}
              aria-autocomplete="list"
              data-testid={`${testId}-search`}
              className="h-8 w-full rounded-sm border-0 bg-transparent px-2 text-sm focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
          {truncated && (
            <p id={capNoteId} className="border-b px-3 py-1.5 text-xs text-muted-foreground" data-testid={`${testId}-cap-note`}>
              {t('billingUi.orgCombobox.capNote', { count: MAX_RESULTS })}
            </p>
          )}
          {results.length > 0 ? (
            <ul id={listId} role="listbox" aria-label={label} className="max-h-64 overflow-auto py-1" data-testid={`${testId}-list`}>
              {results.map((o, idx) => (
                // aria-selected tracks the KEYBOARD cursor, not the committed
                // value — that is what makes arrow navigation audible. The
                // committed org is already carried by the trigger's accessible
                // name, and is shown here visually by the bold weight.
                <li key={o.id} id={optionId(o.id)} role="option" aria-selected={idx === active}>
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
