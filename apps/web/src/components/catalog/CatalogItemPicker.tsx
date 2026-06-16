import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { formatMoney } from '../../lib/timeFormat';
import {
  CATALOG_TYPE_CHIP, CATALOG_TYPE_LABELS,
  type CatalogItem,
} from '../../lib/api/catalog';

interface Props {
  /** Active catalog items to search (caller loads via lib/api/catalog.listCatalog). */
  items: CatalogItem[];
  /** Called when the user picks an item (cleared after). */
  onSelect: (item: CatalogItem) => void;
  /** Include bundles in results (badged). Default true. */
  includeBundles?: boolean;
  placeholder?: string;
  disabled?: boolean;
  testId?: string;
}

const MAX_RESULTS = 8;

/**
 * Shared catalog typeahead: search active catalog items by name or SKU, see the
 * type chip + unit price (+ Bundle badge), pick to add. Reused by the invoice and
 * contract line builders. The dropdown is absolutely positioned within a relative
 * wrapper (callers place it in non-overflow-clipped form areas).
 */
export default function CatalogItemPicker({
  items, onSelect, includeBundles = true, placeholder = 'Search catalog by name or SKU', disabled, testId = 'catalog-picker',
}: Props) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const listId = useId();

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
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

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
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        value={query}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
        data-testid={`${testId}-input`}
      />
      {open && results.length > 0 && (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-30 mt-1 max-h-64 w-full overflow-auto rounded-md border bg-card py-1 shadow-lg"
          data-testid={`${testId}-list`}
        >
          {results.map((item, idx) => (
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
                    Bundle
                  </span>
                )}
                <span className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${CATALOG_TYPE_CHIP[item.itemType]}`}>
                  {CATALOG_TYPE_LABELS[item.itemType]}
                </span>
                {item.sku && <span className="font-mono text-[11px] text-muted-foreground">{item.sku}</span>}
                <span className="tabular-nums text-muted-foreground">{formatMoney(item.unitPrice)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {open && query.trim() !== '' && results.length === 0 && (
        <div
          className="absolute z-30 mt-1 w-full rounded-md border bg-card px-3 py-2 text-xs text-muted-foreground shadow-lg"
          data-testid={`${testId}-noresults`}
        >
          No matching catalog items.
        </div>
      )}
    </div>
  );
}
