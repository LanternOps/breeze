import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { formatMoney } from '../billing/shared/format';
import {
  CATALOG_TYPE_CHIP,
  priceFor,
  type CatalogItem,
} from '../../lib/api/catalog';
import { useTranslation } from 'react-i18next';

interface Props {
  /** Active catalog items to search (caller loads via lib/api/catalog.listCatalog). */
  items: CatalogItem[];
  /** Called when the user picks an item (cleared after). */
  onSelect: (item: CatalogItem) => void;
  /** Document currency (ISO 4217). The price cell shows the item's price-book row
   *  in THIS currency, or a muted "no price" note when the book has no row —
   *  never another currency's number and never a legacy item-level
   *  mirror. Items without a price stay selectable: the server answers the add
   *  with `NO_PRICE_FOR_CURRENCY` and the editor toasts the gap. */
  currencyCode: string;
  /** Include bundles in results (badged). Default true. */
  includeBundles?: boolean;
  placeholder?: string;
  disabled?: boolean;
  testId?: string;
}

const MAX_RESULTS = 8;
const POPUP_GAP_PX = 4;

/**
 * Shared catalog typeahead: search active catalog items by name or SKU, see the
 * type chip + the price-book price in the document currency (+ Bundle badge),
 * pick to add. Reused by the invoice, quote, ticket-parts and contract line
 * builders.
 *
 * The dropdown renders through a portal into `document.body` with `position:
 * fixed`, anchored to the input's rect (same approach as `ActionMenu`). The
 * quote editor's block collapse shell is `overflow-hidden` for its grid-rows
 * animation, and an `absolute` dropdown inside it was clipped to a sliver below
 * the input. It flips above the input when it would overflow the viewport
 * bottom and there is more room above, and follows the input on scroll/resize.
 */
export default function CatalogItemPicker({
  items, onSelect, currencyCode, includeBundles = true, placeholder, disabled, testId = 'catalog-picker',
}: Props) {
  const { t } = useTranslation('common');
  const resolvedPlaceholder = placeholder ?? t('longTail.catalog.CatalogItemPicker.placeholder');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const popupRef = useRef<HTMLElement | null>(null);
  const listId = useId();
  const [popupStyle, setPopupStyle] = useState<CSSProperties>({ position: 'fixed', top: 0, left: 0 });

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items
      .filter((i) => i.isActive && (includeBundles || !i.isBundle))
      .filter((i) => !q || i.name.toLowerCase().includes(q) || (i.sku ?? '').toLowerCase().includes(q))
      .slice(0, MAX_RESULTS);
  }, [items, query, includeBundles]);

  useEffect(() => { setActive(0); }, [query, open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      // The popup is portalled out of `wrapRef`, so it has to be checked too —
      // otherwise a mousedown on an option closes the list before its click lands.
      if (wrapRef.current?.contains(target) || popupRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const showList = open && results.length > 0;
  const showNoResults = open && query.trim() !== '' && results.length === 0;
  const popupVisible = showList || showNoResults;

  useLayoutEffect(() => {
    if (!popupVisible) return;
    const place = () => {
      const input = inputRef.current;
      if (!input) return;
      const rect = input.getBoundingClientRect();
      const popupHeight = popupRef.current?.offsetHeight ?? 0;
      const below = rect.bottom + POPUP_GAP_PX;
      // Flip above the input when the popup would run off the viewport bottom
      // and there is more room above than below.
      const flip = below + popupHeight > window.innerHeight && rect.top > window.innerHeight - rect.bottom;
      setPopupStyle({
        position: 'fixed',
        top: flip ? Math.max(POPUP_GAP_PX, rect.top - POPUP_GAP_PX - popupHeight) : below,
        left: rect.left,
        width: rect.width,
      });
    };
    place();
    // Capture phase: a scroll inside ANY ancestor moves the input, and scroll
    // events do not bubble.
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [popupVisible, results.length]);

  const choose = (item: CatalogItem) => {
    onSelect(item);
    setQuery('');
    setOpen(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') { setOpen(false); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, results.length - 1)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); return; }
    if (e.key === 'Enter' && open && results[active]) { e.preventDefault(); choose(results[active]); }
  };

  return (
    <div ref={wrapRef} className="relative" data-testid={testId}>
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        value={query}
        disabled={disabled}
        placeholder={resolvedPlaceholder}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-50"
        data-testid={`${testId}-input`}
      />
      {showList && createPortal(
        <ul
          ref={(el) => { popupRef.current = el; }}
          id={listId}
          role="listbox"
          style={popupStyle}
          // Keep focus in the input so typing continues and a host dialog's
          // focus handling never sees focus leave for the portalled list.
          onMouseDown={(e) => e.preventDefault()}
          className="z-50 max-h-64 overflow-auto rounded-md border bg-card py-1 shadow-lg"
          data-testid={`${testId}-list`}
        >
          {results.map((item, idx) => {
            const price = priceFor(item, currencyCode);
            return (
            <li key={item.id} role="option" aria-selected={idx === active}>
              <button
                type="button"
                onMouseEnter={() => setActive(idx)}
                onClick={() => choose(item)}
                className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm ${idx === active ? 'bg-muted' : ''}`}
                data-testid={`${testId}-option-${item.id}`}
              >
                <span className="flex-1 truncate font-medium">{item.name}</span>
                {item.isBundle && (
                  <span className="rounded border border-border bg-muted px-1 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    {t('longTail.catalog.CatalogItemPicker.bundle')}
                  </span>
                )}
                <span className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${CATALOG_TYPE_CHIP[item.itemType]}`}>
                  {t(/* i18n-dynamic */ `longTail.catalog.CatalogItemPicker.itemTypes.${item.itemType}`)}
                </span>
                {item.sku && <span className="font-mono chart-legend-xs text-muted-foreground">{item.sku}</span>}
                {price != null ? (
                  <span className="tabular-nums text-muted-foreground" data-testid={`${testId}-price-${item.id}`}>
                    {formatMoney(price, currencyCode)}
                  </span>
                ) : currencyCode ? (
                  <span className="text-[11px] italic text-muted-foreground" data-testid={`${testId}-noprice-${item.id}`}>
                    {t('longTail.catalog.CatalogItemPicker.noPriceInCurrency', { currency: currencyCode })}
                  </span>
                ) : null}
              </button>
            </li>
            );
          })}
        </ul>,
        document.body,
      )}
      {showNoResults && createPortal(
        <div
          ref={(el) => { popupRef.current = el; }}
          style={popupStyle}
          className="z-50 rounded-md border bg-card px-3 py-2 text-xs text-muted-foreground shadow-lg"
          data-testid={`${testId}-noresults`}
        >
          {t('longTail.catalog.CatalogItemPicker.noResults')}
        </div>,
        document.body,
      )}
    </div>
  );
}
