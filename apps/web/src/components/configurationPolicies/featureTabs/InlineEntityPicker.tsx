import { useState, useEffect, useRef, useCallback } from 'react';
import { Search, ChevronDown, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../../stores/auth';

type EntityOption = {
  id: string;
  name: string;
  extra?: string;
};

type InlineEntityPickerProps = {
  value: string;
  onChange: (id: string) => void;
  endpoint: string;
  label: string;
  placeholder?: string;
  /** Transform raw API response items into EntityOption[] */
  transform?: (items: any[]) => EntityOption[];
  /** Compact mode for inline-in-card usage */
  compact?: boolean;
};

const defaultTransform = (items: any[]): EntityOption[] =>
  items.map((item) => ({
    id: item.id,
    name: item.name || item.hostname || item.id,
    extra: item.description || item.type,
  }));

export default function InlineEntityPicker({
  value,
  onChange,
  endpoint,
  label,
  placeholder = 'Select...',
  transform = defaultTransform,
  compact = false,
}: InlineEntityPickerProps) {
  const [options, setOptions] = useState<EntityOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string>();
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const transformRef = useRef(transform);
  transformRef.current = transform;

  const fetchOptions = useCallback(async () => {
    setLoading(true);
    setFetchError(undefined);
    try {
      const res = await fetchWithAuth(endpoint);
      if (!res.ok) throw new Error(`Failed to load (HTTP ${res.status})`);
      const data = await res.json();
      const items = Array.isArray(data.data) ? data.data : Array.isArray(data) ? data : [];
      setOptions(transformRef.current(items));
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : 'Failed to load options');
      setOptions([]);
    } finally { setLoading(false); }
  }, [endpoint]);

  useEffect(() => { fetchOptions(); }, [fetchOptions]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const selected = options.find((o) => o.id === value);
  const filtered = options.filter((o) => {
    const q = search.toLowerCase();
    return o.name.toLowerCase().includes(q) || o.id.toLowerCase().includes(q) ||
           (o.extra && o.extra.toLowerCase().includes(q));
  });

  const height = compact ? 'h-8' : 'h-9';
  const textSize = compact ? 'text-xs' : 'text-sm';

  function getButtonLabel(): string {
    if (selected) return selected.name;
    if (loading) return 'Loading...';
    return placeholder;
  }

  return (
    <div ref={ref} className="relative">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      <div className="mt-1 flex items-center gap-1">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className={cn(
            'flex w-full items-center justify-between rounded-md border bg-background px-2',
            height, textSize,
            'focus:outline-none focus:ring-2 focus:ring-ring'
          )}
        >
          <span className={cn('truncate', selected ? 'text-foreground' : 'text-muted-foreground')}>
            {getButtonLabel()}
          </span>
          <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
        </button>
        {value && (
          <button
            type="button"
            onClick={() => onChange('')}
            className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {open && (
        <div className="absolute z-50 mt-1 w-full rounded-md border bg-popover shadow-lg">
          <div className="flex items-center border-b px-2 py-1.5">
            <Search className="mr-1.5 h-3.5 w-3.5 text-muted-foreground" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search..."
              className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              autoFocus
            />
          </div>
          <div className="max-h-48 overflow-y-auto py-1">
            {loading ? (
              <div className="flex items-center justify-center py-3">
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              </div>
            ) : fetchError ? (
              <div className="px-2 py-3 text-center text-xs text-destructive">{fetchError}</div>
            ) : filtered.length === 0 ? (
              <div className="px-2 py-3 text-center text-xs text-muted-foreground">
                {options.length === 0 ? 'None available' : 'No matches'}
              </div>
            ) : (
              filtered.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => { onChange(option.id); setOpen(false); setSearch(''); }}
                  className={cn(
                    'flex w-full items-center justify-between px-2 py-1.5 text-left text-sm hover:bg-accent',
                    option.id === value && 'bg-accent'
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{option.name}</div>
                    {option.extra && <div className="truncate text-xs text-muted-foreground">{option.extra}</div>}
                  </div>
                  <span className="ml-2 flex-shrink-0 font-mono text-[10px] text-muted-foreground">
                    {option.id.slice(0, 8)}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
