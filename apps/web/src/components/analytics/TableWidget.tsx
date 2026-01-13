import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { cn } from '@/lib/utils';

type TableColumn<T> = {
  key: keyof T & string;
  label: string;
  sortable?: boolean;
  className?: string;
  render?: (value: T[keyof T], row: T) => React.ReactNode;
};

type TableWidgetProps<T extends Record<string, unknown> = Record<string, unknown>> = {
  title: string;
  data: T[];
  columns: TableColumn<T>[];
};

export default function TableWidget<T extends Record<string, unknown>>({
  title,
  data,
  columns
}: TableWidgetProps<T>) {
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<keyof T & string | null>(null);
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');

  const filteredData = useMemo(() => {
    if (!query) return data;
    const normalized = query.toLowerCase();
    return data.filter(row =>
      Object.values(row).some(value => String(value).toLowerCase().includes(normalized))
    );
  }, [data, query]);

  const sortedData = useMemo(() => {
    if (!sortKey) return filteredData;
    return [...filteredData].sort((a, b) => {
      const aValue = a[sortKey];
      const bValue = b[sortKey];
      if (aValue === bValue) return 0;
      if (aValue === undefined || aValue === null) return 1;
      if (bValue === undefined || bValue === null) return -1;
      if (aValue > bValue) return sortDirection === 'asc' ? 1 : -1;
      return sortDirection === 'asc' ? -1 : 1;
    });
  }, [filteredData, sortDirection, sortKey]);

  const handleSort = (key: keyof T & string) => {
    if (sortKey === key) {
      setSortDirection(prev => (prev === 'asc' ? 'desc' : 'asc'));
      return;
    }
    setSortKey(key);
    setSortDirection('asc');
  };

  return (
    <div className="flex h-full flex-col rounded-lg border bg-card p-4 shadow-sm">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">{title}</h3>
        <input
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder="Filter"
          className="h-8 w-40 rounded-md border bg-background px-2 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </div>
      <div className="flex-1 overflow-hidden">
        <div className="max-h-[320px] overflow-auto">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-background">
              <tr className="border-b">
                {columns.map(column => (
                  <th key={column.key} className={cn('px-2 py-2 font-medium text-muted-foreground', column.className)}>
                    <button
                      type="button"
                      onClick={() => column.sortable && handleSort(column.key)}
                      className={cn(
                        'inline-flex items-center gap-1',
                        column.sortable ? 'cursor-pointer hover:text-foreground' : 'cursor-default'
                      )}
                    >
                      {column.label}
                      {column.sortable && sortKey === column.key && (
                        sortDirection === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />
                      )}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sortedData.map((row, index) => (
                <tr key={index} className="border-b last:border-b-0">
                  {columns.map(column => (
                    <td key={column.key} className={cn('px-2 py-2', column.className)}>
                      {column.render ? column.render(row[column.key], row) : String(row[column.key] ?? '')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {sortedData.length === 0 && (
          <div className="flex h-24 items-center justify-center text-xs text-muted-foreground">
            No matching records
          </div>
        )}
      </div>
    </div>
  );
}

export type { TableWidgetProps, TableColumn };
