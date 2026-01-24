import { useState, useMemo, useRef, useEffect } from 'react';
import { ChevronDown, Search } from 'lucide-react';
import type { FilterFieldDefinition, FilterFieldCategory } from '@breeze/shared';

interface FieldSelectorProps {
  value: string;
  onChange: (fieldKey: string) => void;
  fields: FilterFieldDefinition[];
  className?: string;
}

const CATEGORY_LABELS: Record<FilterFieldCategory, string> = {
  core: 'Device',
  os: 'Operating System',
  hardware: 'Hardware',
  network: 'Network',
  metrics: 'Metrics',
  software: 'Software',
  hierarchy: 'Hierarchy',
  custom: 'Custom Fields',
  computed: 'Computed'
};

const CATEGORY_ORDER: FilterFieldCategory[] = [
  'core',
  'os',
  'hardware',
  'network',
  'metrics',
  'software',
  'hierarchy',
  'custom',
  'computed'
];

export function FieldSelector({
  value,
  onChange,
  fields,
  className = ''
}: FieldSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const dropdownRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selectedField = useMemo(() => {
    return fields.find(f => f.key === value);
  }, [fields, value]);

  const groupedFields = useMemo(() => {
    const filtered = searchQuery
      ? fields.filter(f =>
          f.label.toLowerCase().includes(searchQuery.toLowerCase()) ||
          f.key.toLowerCase().includes(searchQuery.toLowerCase())
        )
      : fields;

    const groups = new Map<FilterFieldCategory, FilterFieldDefinition[]>();

    for (const field of filtered) {
      const existing = groups.get(field.category) || [];
      existing.push(field);
      groups.set(field.category, existing);
    }

    return groups;
  }, [fields, searchQuery]);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
        setSearchQuery('');
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Focus search input when dropdown opens
  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isOpen]);

  const handleSelect = (fieldKey: string) => {
    onChange(fieldKey);
    setIsOpen(false);
    setSearchQuery('');
  };

  return (
    <div ref={dropdownRef} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="flex h-9 w-48 items-center justify-between rounded-md border bg-background px-3 text-sm hover:bg-muted"
      >
        <span className="truncate">{selectedField?.label || 'Select field'}</span>
        <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
      </button>

      {isOpen && (
        <div className="absolute top-full left-0 z-50 mt-1 w-72 rounded-md border bg-popover shadow-lg">
          <div className="p-2 border-b">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                ref={inputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search fields..."
                className="h-8 w-full rounded-md border bg-background pl-8 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          </div>

          <div className="max-h-72 overflow-y-auto p-1">
            {groupedFields.size === 0 ? (
              <div className="px-3 py-2 text-sm text-muted-foreground">
                No fields match your search
              </div>
            ) : (
              CATEGORY_ORDER.map((category) => {
                const categoryFields = groupedFields.get(category);
                if (!categoryFields || categoryFields.length === 0) return null;

                return (
                  <div key={category}>
                    <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">
                      {CATEGORY_LABELS[category]}
                    </div>
                    {categoryFields.map((field) => (
                      <button
                        key={field.key}
                        type="button"
                        onClick={() => handleSelect(field.key)}
                        className={`flex w-full items-start gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted ${
                          field.key === value ? 'bg-muted' : ''
                        }`}
                      >
                        <div className="flex-1 min-w-0">
                          <div className="font-medium truncate">{field.label}</div>
                          {field.description && (
                            <div className="text-xs text-muted-foreground truncate">
                              {field.description}
                            </div>
                          )}
                        </div>
                        {field.computed && (
                          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                            Computed
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default FieldSelector;
