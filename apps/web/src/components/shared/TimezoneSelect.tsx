// Searchable IANA timezone picker (issue #2856).
//
// This replaces the hardcoded 10- and 15-entry <select> lists that used to live
// in SiteForm, SiteDetailPage, and PartnerRegionalTab. Those lists had drifted
// apart, and the one used for org/site creation had no Europe/Paris at all — a
// French self-hoster literally could not pick their own timezone. The options
// now come from `listIanaTimezones()` (Intl, ~418 zones), which makes a bare
// <select> unusable, so this is a combobox with a filter field.
//
// ARIA shape follows OrgCombobox: the trigger is a plain disclosure BUTTON that
// shows the committed value, and `role="combobox"` belongs to the search input
// inside the popup — that is the element holding focus while the user types and
// arrows. `aria-activedescendant` tracks the keyboard cursor and option
// `aria-selected` follows it; the committed zone is conveyed by the trigger's
// own text, not by aria-selected.
//
// Deliberately NOT capped to the first N matches. OrgCombobox caps at 50 with
// an announced note, which is right for an unbounded org list; here truncating
// the browse list is the exact failure this component exists to fix — a user
// scrolling for Europe/Paris must never be shown a list that silently stops in
// Africa/*. 418 list items render fine inside the scroll container.
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { listIanaTimezones } from '@breeze/shared';
import { useClickOutside } from '@/hooks/useClickOutside';
import '@/lib/i18n';

interface Props {
  /** Current IANA zone. Rendered even when it is not in the Intl list, so a
   *  site holding a legacy or unusual zone never silently loses it. */
  value: string;
  onChange: (timezone: string) => void;
  /** Accessible name for the control (e.g. "Timezone"). */
  label: string;
  /** Applied to the trigger button so an external <label htmlFor> resolves. */
  id?: string;
  disabled?: boolean;
  testId: string;
}

// `Intl.DateTimeFormat` per zone is not free and the offsets are stable for the
// life of the page, so memoize. Rendering all ~418 options means this fills in
// on first open and costs nothing afterwards.
const offsetCache = new Map<string, string>();

function offsetLabel(timezone: string): string {
  const cached = offsetCache.get(timezone);
  if (cached !== undefined) return cached;
  let label = '';
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'shortOffset',
    }).formatToParts(new Date());
    label = parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
  } catch {
    // An invalid stored zone must still be selectable/visible — it just gets no
    // offset hint. Throwing here would blank the whole settings form.
    label = '';
  }
  offsetCache.set(timezone, label);
  return label;
}

// "Europe/Paris" should match a search for "paris", and "America/New_York" for
// "new york" — users type the city, not the underscore form.
function searchable(timezone: string): string {
  return timezone.toLowerCase().replace(/_/g, ' ');
}

export default function TimezoneSelect({ value, onChange, label, id, disabled, testId }: Props) {
  const { t } = useTranslation('common');
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const optionId = (timezone: string) => `${listId}-opt-${timezone}`;

  // The stored value wins over the Intl list: an org whose timezone predates
  // this picker (or came from the API, which accepts any string) still shows
  // its real value instead of being silently rewritten to the first option —
  // the behaviour the old SiteForm effect hand-rolled.
  const zones = useMemo(() => {
    const all = listIanaTimezones();
    return value && !all.includes(value) ? [value, ...all] : all;
  }, [value]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/_/g, ' ');
    if (!q) return zones;
    return zones.filter((zone) => searchable(zone).includes(q));
  }, [zones, query]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    // Open on the committed zone so the list starts where the user left it
    // rather than at UTC — with 418 entries, resetting to the top would mean
    // scrolling from Africa/Abidjan every time.
    const index = zones.indexOf(value);
    setActive(index >= 0 ? index : 0);
    searchRef.current?.focus();
  }, [open, value, zones]);

  useClickOutside(open, wrapRef, () => setOpen(false));

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const choose = (timezone: string) => {
    close();
    onChange(timezone);
  };

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((a) => Math.min(a + 1, results.length - 1));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const chosen = results[active];
      if (chosen) choose(chosen);
    }
  };

  return (
    <div ref={wrapRef} className="relative w-full" data-testid={testId}>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={label}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(event) => {
          if (!open && (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault();
            setOpen(true);
          }
        }}
        data-testid={`${testId}-trigger`}
        className="inline-flex h-10 w-full items-center gap-2 rounded-md border bg-background px-3 text-sm transition-colors focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
      >
        <span className="min-w-0 flex-1 truncate text-left">{value}</span>
        {offsetLabel(value) && (
          <span className="shrink-0 text-xs text-muted-foreground">{offsetLabel(value)}</span>
        )}
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      </button>
      {open && (
        <div
          className="absolute left-0 top-full z-30 mt-1 w-full min-w-64 rounded-md border bg-card shadow-lg"
          data-testid={`${testId}-popover`}
        >
          <div className="border-b p-1.5">
            <input
              ref={searchRef}
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onSearchKeyDown}
              placeholder={t('shared.timezoneSelect.searchPlaceholder')}
              aria-label={t('shared.timezoneSelect.searchPlaceholder')}
              role="combobox"
              aria-expanded
              // Never reference an id that is not in the DOM: the listbox is
              // not rendered when nothing matches.
              aria-controls={results.length > 0 ? listId : undefined}
              aria-activedescendant={results[active] ? optionId(results[active]) : undefined}
              aria-autocomplete="list"
              data-testid={`${testId}-search`}
              className="h-8 w-full rounded-sm border-0 bg-transparent px-2 text-sm focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
          {results.length > 0 ? (
            <ul
              id={listId}
              role="listbox"
              aria-label={label}
              className="max-h-64 overflow-auto py-1"
              data-testid={`${testId}-list`}
            >
              {results.map((zone, index) => (
                // aria-selected tracks the KEYBOARD cursor, not the committed
                // zone — that is what makes arrowing audible to assistive tech.
                <li key={zone} id={optionId(zone)} role="option" aria-selected={index === active}>
                  <button
                    type="button"
                    tabIndex={-1}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => choose(zone)}
                    data-testid={`${testId}-option-${zone}`}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm ${index === active ? 'bg-muted' : ''} ${zone === value ? 'font-medium' : ''}`}
                  >
                    <span className="min-w-0 flex-1 truncate">{zone}</span>
                    {offsetLabel(zone) && (
                      <span className="shrink-0 text-xs text-muted-foreground">{offsetLabel(zone)}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-3 py-2 text-xs text-muted-foreground" data-testid={`${testId}-noresults`}>
              {t('shared.timezoneSelect.noResults')}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
