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
import { isValidIanaTimezone, listIanaTimezones } from '@breeze/shared';
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
  testId: string;
}

// Offsets are decorative, so a runtime that cannot produce them degrades to no
// hint rather than breaking the picker. `timeZoneName: 'shortOffset'` is ES2022
// — the same vintage as `Intl.supportedValuesOf` — so on the old runtimes that
// need `listIanaTimezones()`'s fallback list, this throws for the *option*
// (i.e. for every zone), not for the zone.
//
// Cached because ~418 `Intl.DateTimeFormat` constructions are not free and the
// list is rendered whole. The cached value can go stale across a DST transition
// in a tab left open for months; showing a one-hour-off hint beside a correct
// zone id is a fair trade for not rebuilding 418 formatters on every keystroke.
// Failures are deliberately NOT cached — caching a failure latches it for the
// page even when the cause was per-call.
const offsetCache = new Map<string, string>();

function offsetLabel(timezone: string): string {
  const cached = offsetCache.get(timezone);
  if (cached !== undefined) return cached;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'shortOffset',
    }).formatToParts(new Date());
    const label = parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
    offsetCache.set(timezone, label);
    return label;
  } catch {
    return '';
  }
}

// "Europe/Paris" should match a search for "paris", and "America/New_York" for
// "new york" — users type the city, not the underscore form.
function searchable(timezone: string): string {
  return timezone.toLowerCase().replace(/_/g, ' ');
}

export default function TimezoneSelect({ value, onChange, label, id, testId }: Props) {
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

  // `active` has exactly ONE writer per user action, deliberately. An earlier
  // version reset it from a `[query]` effect *and* seeded it from the open
  // effect; because the open effect also cleared a stale query, the two fired
  // on the same commit and the reset won — so opening, typing, pressing Escape,
  // reopening and pressing Enter committed UTC over the user's real zone. A
  // picker that silently rewrites a timezone is the bug this file exists to
  // fix, so the query is now cleared on CLOSE and `active` is set inline by
  // whichever action changed it.
  useEffect(() => {
    if (!open) return;
    // Open on the committed zone so the list starts where the user left it
    // rather than at UTC — with 418 entries, resetting to the top would mean
    // scrolling from Africa/Abidjan every time.
    const index = zones.indexOf(value);
    setActive(index >= 0 ? index : 0);
    searchRef.current?.focus();
  }, [open, value, zones]);

  // Seeding `active` deep in the list (or arrowing past the ~8 visible rows of
  // `max-h-64`) does nothing on its own — the scroll container stays parked at
  // Africa/Abidjan while `aria-activedescendant` points elsewhere, so sighted
  // and screen-reader users see different things. OrgCombobox avoids this by
  // capping at 50 results; this picker deliberately shows all 418, so it has to
  // move the viewport itself. A native <select> did this for free.
  useEffect(() => {
    if (!open) return;
    const zone = results[active];
    if (!zone) return;
    const el = document.getElementById(optionId(zone));
    // jsdom has no layout and so no `scrollIntoView`; this is decorative
    // viewport movement, so feature-detect rather than let tests explode.
    if (typeof el?.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
    // `results` is intentionally omitted from the deps: this must follow the
    // cursor, and re-running on every keystroke would fight the browser.
  }, [active, open]);

  const close = () => {
    setOpen(false);
    // Cleared here rather than on open: leaving a stale query behind is what
    // forced the open effect to clear it, which is what created the race above.
    setQuery('');
    triggerRef.current?.focus();
  };

  const choose = (timezone: string) => {
    close();
    onChange(timezone);
  };

  // Dismissing by clicking elsewhere must not silently eat a typed-but-
  // unconfirmed zone. `useClickOutside` fires on mousedown, so the very same
  // click can land on a Save button afterwards — discarding the query there
  // would save the OLD zone under a green "Saved", which is exactly the
  // silent-wrong-value class of bug this component exists to remove.
  //
  // Only an UNAMBIGUOUS query is committed (an exact zone id, or a filter that
  // narrowed to a single row). Anything still ambiguous is a genuine "I changed
  // my mind" and is discarded, which is what clicking away normally means.
  const dismiss = () => {
    const typed = query.trim();
    if (typed) {
      const normalized = typed.toLowerCase().replace(/_/g, ' ');
      const chosen =
        results.find((zone) => searchable(zone) === normalized) ??
        (results.length === 1 ? results[0] : undefined);
      if (chosen && chosen !== value) {
        setOpen(false);
        setQuery('');
        onChange(chosen);
        return;
      }
    }
    setOpen(false);
    setQuery('');
  };

  useClickOutside(open, wrapRef, dismiss);

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
        // `aria-label` overrides name-from-content, so it must carry the value
        // too — otherwise the trigger announces only "Timezone, button" and the
        // committed zone becomes invisible to screen readers, a regression from
        // the native <select> ("Timezone, combo box, America/New_York").
        aria-label={`${label}: ${value}`}
        // Must go through `close()`, not a bare `setOpen(false)`. The trigger
        // sits inside `wrapRef`, so `useClickOutside` never fires for it — a
        // bare toggle would be a third exit that leaves `query` set, and on
        // reopen the effect below seeds `active` from the UNFILTERED `zones`
        // while `results` is still filtered, so Enter commits `results[active]`
        // — a zone the user never looked at.
        onClick={() => (open ? close() : setOpen(true))}
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
              onChange={(event) => {
                setQuery(event.target.value);
                // Same action, same writer: a new filter always re-homes the
                // cursor to the top of the NEW result set, so Enter can never
                // commit a stale index into a different list.
                setActive(0);
              }}
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
      {/* A stored zone the API will reject (`isValidIanaTimezone` guards every
          timezone write) otherwise looks like an ordinary option, and the user
          only finds out when an unrelated edit fails to save with a generic
          error. Name the problem where it can be fixed. */}
      {value !== '' && !isValidIanaTimezone(value) && (
        <p className="text-sm text-destructive" data-testid={`${testId}-invalid`}>
          {t('shared.timezoneSelect.invalidStored', { value })}
        </p>
      )}
    </div>
  );
}
