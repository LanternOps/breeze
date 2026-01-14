import { useMemo, useState } from 'react';
import { Calendar, Check, ChevronDown, Search, User, X } from 'lucide-react';
import { cn } from '@/lib/utils';

type DatePreset = 'today' | '7d' | '30d' | 'custom';

type AuditFiltersState = {
  datePreset: DatePreset;
  startDate?: string;
  endDate?: string;
  userId?: string;
  actions: string[];
  resources: string[];
  search: string;
};

type AuditFiltersProps = {
  onApply?: (filters: AuditFiltersState) => void;
  onClear?: () => void;
};

const actionOptions = ['login', 'update', 'delete', 'create', 'export', 'access'];
const resourceOptions = ['policy', 'report', 'dataset', 'identity', 'automation', 'asset'];

const mockUsers = [
  { id: 'user_1', name: 'Ariana Fields', email: 'ariana.fields@northwind.dev' },
  { id: 'user_2', name: 'Miguel Rogers', email: 'miguel.rogers@northwind.dev' },
  { id: 'user_3', name: 'Priya Nair', email: 'priya.nair@northwind.dev' },
  { id: 'user_4', name: 'Kai Mendoza', email: 'kai.mendoza@northwind.dev' },
  { id: 'user_5', name: 'Grace Liu', email: 'grace.liu@northwind.dev' }
];

const presetLabels: Record<DatePreset, string> = {
  today: 'Today',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  custom: 'Custom'
};

export default function AuditFilters({ onApply, onClear }: AuditFiltersProps) {
  const [datePreset, setDatePreset] = useState<DatePreset>('7d');
  const [customStart, setCustomStart] = useState('2024-05-21');
  const [customEnd, setCustomEnd] = useState('2024-05-28');
  const [userSearch, setUserSearch] = useState('');
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState<string | undefined>();
  const [selectedActions, setSelectedActions] = useState<string[]>(['login', 'update']);
  const [selectedResources, setSelectedResources] = useState<string[]>(['policy', 'report']);
  const [detailsSearch, setDetailsSearch] = useState('');

  const filteredUsers = useMemo(() => {
    const search = userSearch.toLowerCase();
    return mockUsers.filter(user => user.name.toLowerCase().includes(search));
  }, [userSearch]);

  const selectedUser = mockUsers.find(user => user.id === selectedUserId);

  const toggleSelection = (value: string, list: string[], setter: (next: string[]) => void) => {
    if (list.includes(value)) {
      setter(list.filter(item => item !== value));
    } else {
      setter([...list, value]);
    }
  };

  const handleApply = () => {
    onApply?.({
      datePreset,
      startDate: datePreset === 'custom' ? customStart : undefined,
      endDate: datePreset === 'custom' ? customEnd : undefined,
      userId: selectedUserId,
      actions: selectedActions,
      resources: selectedResources,
      search: detailsSearch
    });
  };

  const handleClear = () => {
    setDatePreset('7d');
    setCustomStart('2024-05-21');
    setCustomEnd('2024-05-28');
    setUserSearch('');
    setSelectedUserId(undefined);
    setSelectedActions([]);
    setSelectedResources([]);
    setDetailsSearch('');
    onClear?.();
  };

  return (
    <div className="space-y-6 rounded-lg border bg-card p-6">
      <div>
        <h2 className="text-lg font-semibold">Audit Filters</h2>
        <p className="text-sm text-muted-foreground">Refine audit entries by user, action, and resource.</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Calendar className="h-4 w-4 text-muted-foreground" />
            Date Range
          </div>
          <div className="flex flex-wrap gap-2">
            {(Object.keys(presetLabels) as DatePreset[]).map(preset => (
              <button
                key={preset}
                type="button"
                onClick={() => setDatePreset(preset)}
                className={cn(
                  'rounded-full border px-3 py-1 text-xs font-medium',
                  datePreset === preset
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {presetLabels[preset]}
              </button>
            ))}
          </div>
          {datePreset === 'custom' && (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-2 text-xs font-semibold uppercase text-muted-foreground">
                Start
                <input
                  type="date"
                  value={customStart}
                  onChange={event => setCustomStart(event.target.value)}
                  className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm text-foreground"
                />
              </label>
              <label className="space-y-2 text-xs font-semibold uppercase text-muted-foreground">
                End
                <input
                  type="date"
                  value={customEnd}
                  onChange={event => setCustomEnd(event.target.value)}
                  className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm text-foreground"
                />
              </label>
            </div>
          )}
        </div>

        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <User className="h-4 w-4 text-muted-foreground" />
            User
          </div>
          <div className="relative">
            <div className="flex items-center gap-2 rounded-md border bg-background px-3 py-2">
              <Search className="h-4 w-4 text-muted-foreground" />
              <input
                type="text"
                value={userSearch}
                onChange={event => setUserSearch(event.target.value)}
                onFocus={() => setUserMenuOpen(true)}
                onBlur={() => setTimeout(() => setUserMenuOpen(false), 150)}
                placeholder="Search users"
                className="w-full bg-transparent text-sm text-foreground outline-none"
              />
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            </div>
            {userMenuOpen && (
              <div className="absolute z-10 mt-2 w-full rounded-md border bg-card shadow-lg">
                {filteredUsers.length === 0 && (
                  <div className="px-3 py-2 text-sm text-muted-foreground">No users found</div>
                )}
                {filteredUsers.map(user => (
                  <button
                    key={user.id}
                    type="button"
                    onMouseDown={event => {
                      event.preventDefault();
                      setSelectedUserId(user.id);
                      setUserSearch(user.name);
                      setUserMenuOpen(false);
                    }}
                    className={cn(
                      'flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-muted/60',
                      selectedUserId === user.id && 'bg-muted/60'
                    )}
                  >
                    <span>
                      <span className="font-medium text-foreground">{user.name}</span>
                      <span className="ml-2 text-xs text-muted-foreground">{user.email}</span>
                    </span>
                    {selectedUserId === user.id && <Check className="h-4 w-4 text-primary" />}
                  </button>
                ))}
              </div>
            )}
          </div>
          {selectedUser && (
            <div className="flex items-center justify-between rounded-md border bg-muted/30 px-3 py-2 text-sm">
              <span className="text-muted-foreground">
                Filtering by <span className="font-medium text-foreground">{selectedUser.name}</span>
              </span>
              <button
                type="button"
                onClick={() => {
                  setSelectedUserId(undefined);
                  setUserSearch('');
                }}
                className="inline-flex items-center gap-1 text-xs font-semibold text-muted-foreground hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
                Clear
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-3">
          <h3 className="text-sm font-semibold">Action Types</h3>
          <div className="grid gap-2 sm:grid-cols-2">
            {actionOptions.map(action => (
              <label
                key={action}
                className="flex items-center justify-between rounded-md border bg-background px-3 py-2 text-sm"
              >
                <span className="capitalize text-foreground">{action}</span>
                <input
                  type="checkbox"
                  checked={selectedActions.includes(action)}
                  onChange={() => toggleSelection(action, selectedActions, setSelectedActions)}
                  className="h-4 w-4 rounded border-muted text-primary"
                />
              </label>
            ))}
          </div>
        </div>

        <div className="space-y-3">
          <h3 className="text-sm font-semibold">Resource Types</h3>
          <div className="grid gap-2 sm:grid-cols-2">
            {resourceOptions.map(resource => (
              <label
                key={resource}
                className="flex items-center justify-between rounded-md border bg-background px-3 py-2 text-sm"
              >
                <span className="capitalize text-foreground">{resource}</span>
                <input
                  type="checkbox"
                  checked={selectedResources.includes(resource)}
                  onChange={() => toggleSelection(resource, selectedResources, setSelectedResources)}
                  className="h-4 w-4 rounded border-muted text-primary"
                />
              </label>
            ))}
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <h3 className="text-sm font-semibold">Search Details</h3>
        <div className="flex items-center gap-2 rounded-md border bg-background px-3 py-2">
          <Search className="h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            value={detailsSearch}
            onChange={event => setDetailsSearch(event.target.value)}
            placeholder="Search activity details"
            className="w-full bg-transparent text-sm text-foreground outline-none"
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={handleApply}
          className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Apply Filters
        </button>
        <button
          type="button"
          onClick={handleClear}
          className="inline-flex h-10 items-center justify-center rounded-md border px-4 text-sm font-medium text-muted-foreground hover:text-foreground"
        >
          Clear All
        </button>
      </div>
    </div>
  );
}
