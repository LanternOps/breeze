// "+ Add filter" popover. Lists all V2_FILTER_FIELDS grouped by category,
// with a search-as-you-type box at top. Calls onSelect(field) when user picks.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, Plus } from 'lucide-react';
import type { FilterFieldDefinition } from '@breeze/shared';
import { V2_FILTER_FIELDS, fieldCategoryLabel } from './filterFields';
import { useClickOutside } from '../../hooks/useClickOutside';

export interface FilterAddDropdownProps {
  onSelect: (field: FilterFieldDefinition) => void;
}

export function FilterAddDropdown({ onSelect }: FilterAddDropdownProps) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useClickOutside(open, containerRef, () => setOpen(false));

  const groups = useMemo(() => {
    const lcq = q.toLowerCase().trim();
    const filtered = lcq
      ? V2_FILTER_FIELDS.filter(f =>
          f.label.toLowerCase().includes(lcq) ||
          f.key.toLowerCase().includes(lcq))
      : V2_FILTER_FIELDS;
    const byCat = new Map<string, FilterFieldDefinition[]>();
    for (const f of filtered) {
      const list = byCat.get(f.category) ?? [];
      list.push(f);
      byCat.set(f.category, list);
    }
    return Array.from(byCat.entries());
  }, [q]);

  return (
    <div className="relative inline-block" ref={containerRef}>
      <button
        type="button"
        data-testid="filter-add-button"
        onClick={() => setOpen(o => !o)}
        className="inline-flex items-center gap-1.5 rounded-full border border-dashed px-3 py-1 text-sm text-muted-foreground hover:bg-muted"
      >
        <Plus className="h-3.5 w-3.5" />
        Add filter
      </button>

      {open && (
        <div className="absolute left-0 top-9 z-30 w-80 rounded-md border bg-popover shadow-lg" role="dialog">
          <div className="flex items-center gap-2 border-b px-3 py-2">
            <Search className="h-4 w-4 text-muted-foreground" />
            <input
              ref={inputRef}
              type="text"
              data-testid="filter-add-search"
              placeholder="Search fields..."
              value={q}
              onChange={e => setQ(e.target.value)}
              className="flex-1 bg-transparent text-sm outline-none"
            />
          </div>
          <div className="max-h-72 overflow-y-auto p-2">
            {groups.length === 0 && (
              <div className="px-2 py-4 text-center text-sm text-muted-foreground">No matching fields</div>
            )}
            {groups.map(([cat, fields]) => (
              <div key={cat} className="mb-2">
                <div className="px-2 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {fieldCategoryLabel(cat)}
                </div>
                <ul>
                  {fields.map(f => (
                    <li key={f.key}>
                      <button
                        type="button"
                        data-testid={`filter-add-field-${f.key}`}
                        onClick={() => {
                          onSelect(f);
                          setOpen(false);
                          setQ('');
                        }}
                        className="w-full rounded px-2 py-1 text-left text-sm hover:bg-muted"
                      >
                        {f.label}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
