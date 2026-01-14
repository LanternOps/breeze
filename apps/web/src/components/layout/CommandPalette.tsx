import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bell,
  Clock,
  FileCode,
  Loader2,
  Monitor,
  Plus,
  Search,
  Settings,
  Terminal,
  Users,
  Zap,
  type LucideIcon
} from 'lucide-react';
import { cn } from '@/lib/utils';

type SearchCategory = 'devices' | 'scripts' | 'alerts' | 'users' | 'settings';

type SearchResult = {
  id?: string;
  type: SearchCategory;
  title: string;
  description?: string;
  href?: string;
};

type RecentItem = {
  key: string;
  title: string;
  description?: string;
  href?: string;
  category?: SearchCategory;
  kind: 'action' | 'result';
};

type CommandItem = {
  key: string;
  title: string;
  description?: string;
  href?: string;
  icon: LucideIcon;
  kind: 'action' | 'recent' | 'result';
  category?: SearchCategory;
};

type Section = {
  id: string;
  label: string;
  icon: LucideIcon;
  items: CommandItem[];
};

const CATEGORY_ORDER: SearchCategory[] = [
  'devices',
  'scripts',
  'alerts',
  'users',
  'settings'
];

const CATEGORY_CONFIG: Record<
  SearchCategory,
  {
    label: string;
    icon: LucideIcon;
    baseHref: string;
    detailHref?: (id: string) => string;
  }
> = {
  devices: {
    label: 'Devices',
    icon: Monitor,
    baseHref: '/devices',
    detailHref: (id) => `/devices/${id}`
  },
  scripts: {
    label: 'Scripts',
    icon: FileCode,
    baseHref: '/scripts',
    detailHref: (id) => `/scripts/${id}`
  },
  alerts: {
    label: 'Alerts',
    icon: Bell,
    baseHref: '/alerts'
  },
  users: {
    label: 'Users',
    icon: Users,
    baseHref: '/settings/users'
  },
  settings: {
    label: 'Settings',
    icon: Settings,
    baseHref: '/settings'
  }
};

const QUICK_ACTIONS: Array<{
  key: string;
  title: string;
  description: string;
  href: string;
  icon: LucideIcon;
}> = [
  {
    key: 'action:new-device',
    title: 'New device',
    description: 'Add a device to your fleet',
    href: '/devices',
    icon: Plus
  },
  {
    key: 'action:run-script',
    title: 'Run script',
    description: 'Execute a script on devices',
    href: '/scripts',
    icon: Terminal
  },
  {
    key: 'action:create-alert-rule',
    title: 'Create alert rule',
    description: 'Build a new alert rule',
    href: '/alerts/rules/new',
    icon: Bell
  }
];

const RECENT_STORAGE_KEY = 'breeze.commandPalette.recent';
const MAX_RECENTS = 6;
const SEARCH_DEBOUNCE_MS = 200;

const pickString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const pickId = (record: Record<string, unknown>): string | undefined => {
  const candidates = [
    record.id,
    record.deviceId,
    record.scriptId,
    record.alertId,
    record.userId,
    record.settingId
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
    if (typeof candidate === 'number') return String(candidate);
  }
  return undefined;
};

const pickTitle = (record: Record<string, unknown>): string | undefined => {
  return (
    pickString(record.title) ||
    pickString(record.name) ||
    pickString(record.hostname) ||
    pickString(record.username) ||
    pickString(record.email) ||
    pickString(record.label)
  );
};

const pickDescription = (record: Record<string, unknown>): string | undefined => {
  return (
    pickString(record.description) ||
    pickString(record.summary) ||
    pickString(record.detail) ||
    pickString(record.status) ||
    pickString(record.severity)
  );
};

const pickType = (record: Record<string, unknown>): SearchCategory | undefined => {
  const candidate = pickString(record.type) || pickString(record.category);
  if (candidate && CATEGORY_ORDER.includes(candidate as SearchCategory)) {
    return candidate as SearchCategory;
  }
  return undefined;
};

const normalizeResults = (payload: unknown): SearchResult[] => {
  if (!payload || typeof payload !== 'object') return [];

  const data = payload as Record<string, unknown>;
  const results: SearchResult[] = [];

  const pushResult = (item: unknown, fallbackType?: SearchCategory) => {
    if (!item || typeof item !== 'object') return;
    const record = item as Record<string, unknown>;
    const type = pickType(record) ?? fallbackType;
    if (!type) return;

    const title = pickTitle(record);
    if (!title) return;

    results.push({
      id: pickId(record),
      type,
      title,
      description: pickDescription(record),
      href: pickString(record.href) || pickString(record.url)
    });
  };

  if (Array.isArray(data.results)) {
    data.results.forEach((item) => pushResult(item));
    return results;
  }

  CATEGORY_ORDER.forEach((category) => {
    const items = data[category];
    if (Array.isArray(items)) {
      items.forEach((item) => pushResult(item, category));
    }
  });

  return results;
};

const buildResultHref = (result: SearchResult): string => {
  if (result.href) return result.href;
  const config = CATEGORY_CONFIG[result.type];
  if (result.id && config.detailHref) return config.detailHref(result.id);
  return config.baseHref;
};

export default function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [modifierLabel, setModifierLabel] = useState('Ctrl');
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [recentItems, setRecentItems] = useState<RecentItem[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const trimmedQuery = query.trim();
  const showQuickActions = trimmedQuery.length === 0;
  const showRecent = trimmedQuery.length === 0 && recentItems.length > 0;
  const showResults = trimmedQuery.length > 0;

  useEffect(() => {
    if (typeof navigator !== 'undefined' && /mac/i.test(navigator.platform)) {
      setModifierLabel('Cmd');
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const stored = window.localStorage.getItem(RECENT_STORAGE_KEY);
    if (!stored) return;
    try {
      const parsed = JSON.parse(stored) as RecentItem[];
      if (Array.isArray(parsed)) {
        setRecentItems(parsed.slice(0, MAX_RECENTS));
      }
    } catch {
      setRecentItems([]);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(query.trim());
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    if (!debouncedQuery) {
      setResults([]);
      setErrorMessage(null);
      setIsLoading(false);
      return;
    }

    let isActive = true;
    const controller = new AbortController();
    setIsLoading(true);
    setErrorMessage(null);

    fetch(`/api/search?q=${encodeURIComponent(debouncedQuery)}`, {
      signal: controller.signal
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error('Search failed');
        }
        return response.json();
      })
      .then((data) => {
        if (!isActive) return;
        setResults(normalizeResults(data));
      })
      .catch((error: Error) => {
        if (!isActive || error.name === 'AbortError') return;
        setResults([]);
        setErrorMessage('Unable to load search results.');
      })
      .finally(() => {
        if (!isActive) return;
        setIsLoading(false);
      });

    return () => {
      isActive = false;
      controller.abort();
    };
  }, [debouncedQuery, open]);

  useEffect(() => {
    if (open) return;
    setQuery('');
    setDebouncedQuery('');
    setResults([]);
    setErrorMessage(null);
    setIsLoading(false);
    setActiveIndex(-1);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const addRecentItem = useCallback((item: CommandItem) => {
    const nextItem: RecentItem = {
      key: item.key,
      title: item.title,
      description: item.description,
      href: item.href,
      category: item.category,
      kind: item.category ? 'result' : 'action'
    };

    setRecentItems((prev) => {
      const next = [nextItem, ...prev.filter((entry) => entry.key !== nextItem.key)];
      const sliced = next.slice(0, MAX_RECENTS);
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(sliced));
      }
      return sliced;
    });
  }, []);

  const handleSelectItem = useCallback(
    (item: CommandItem) => {
      if (item.href && typeof window !== 'undefined') {
        window.location.href = item.href;
      }
      addRecentItem(item);
      setOpen(false);
    },
    [addRecentItem]
  );

  const quickActionItems = useMemo<CommandItem[]>(() => {
    return QUICK_ACTIONS.map((action) => ({
      key: action.key,
      title: action.title,
      description: action.description,
      href: action.href,
      icon: action.icon,
      kind: 'action'
    }));
  }, []);

  const recentCommandItems = useMemo<CommandItem[]>(() => {
    return recentItems.map((item) => ({
      key: item.key,
      title: item.title,
      description: item.description,
      href: item.href,
      icon: item.category ? CATEGORY_CONFIG[item.category].icon : Zap,
      kind: 'recent',
      category: item.category
    }));
  }, [recentItems]);

  const resultItemsByCategory = useMemo(() => {
    const grouped = CATEGORY_ORDER.reduce((acc, category) => {
      acc[category] = [];
      return acc;
    }, {} as Record<SearchCategory, CommandItem[]>);

    results.forEach((result, index) => {
      const key = `result:${result.type}:${result.id ?? `${result.title}-${index}`}`;
      grouped[result.type].push({
        key,
        title: result.title,
        description: result.description,
        href: buildResultHref(result),
        icon: CATEGORY_CONFIG[result.type].icon,
        kind: 'result',
        category: result.type
      });
    });

    return grouped;
  }, [results]);

  const { sections, selectableItems, indexByKey } = useMemo(() => {
    const builtSections: Section[] = [];
    const selectable: CommandItem[] = [];
    const indexMap = new Map<string, number>();

    const pushSection = (section: Section) => {
      if (section.items.length === 0) return;
      builtSections.push(section);
      section.items.forEach((item) => {
        indexMap.set(item.key, selectable.length);
        selectable.push(item);
      });
    };

    if (showQuickActions) {
      pushSection({
        id: 'quick-actions',
        label: 'Quick actions',
        icon: Zap,
        items: quickActionItems
      });
    }

    if (showRecent) {
      pushSection({
        id: 'recent',
        label: 'Recent',
        icon: Clock,
        items: recentCommandItems
      });
    }

    if (showResults) {
      CATEGORY_ORDER.forEach((category) => {
        const items = resultItemsByCategory[category];
        if (items.length === 0) return;
        pushSection({
          id: category,
          label: CATEGORY_CONFIG[category].label,
          icon: CATEGORY_CONFIG[category].icon,
          items
        });
      });
    }

    return { sections: builtSections, selectableItems: selectable, indexByKey: indexMap };
  }, [
    quickActionItems,
    recentCommandItems,
    resultItemsByCategory,
    showQuickActions,
    showRecent,
    showResults
  ]);

  const activeItemKey = selectableItems[activeIndex]?.key;

  useEffect(() => {
    if (!open) return;
    if (selectableItems.length === 0) {
      setActiveIndex(-1);
      return;
    }
    setActiveIndex((prev) => {
      if (prev < 0) return 0;
      if (prev >= selectableItems.length) return selectableItems.length - 1;
      return prev;
    });
  }, [open, selectableItems.length]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, []);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActiveIndex((prev) =>
          selectableItems.length === 0 ? -1 : (prev + 1) % selectableItems.length
        );
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveIndex((prev) =>
          selectableItems.length === 0
            ? -1
            : (prev - 1 + selectableItems.length) % selectableItems.length
        );
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        const activeItem = selectableItems[activeIndex];
        if (activeItem) {
          handleSelectItem(activeItem);
        }
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeIndex, handleSelectItem, open, selectableItems]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-9 w-80 items-center gap-2 rounded-md border bg-background px-3 text-sm text-muted-foreground hover:bg-muted/40 focus:outline-none focus:ring-2 focus:ring-ring"
      >
        <Search className="h-4 w-4" />
        <span className="flex-1 text-left">Search devices, scripts, alerts, users, settings</span>
        <span className="rounded border bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase text-muted-foreground">
          {modifierLabel}+K
        </span>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 px-4 py-8"
          onClick={() => setOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            className="w-full max-w-2xl overflow-hidden rounded-lg border bg-card shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center gap-3 border-b px-4 py-3">
              <Search className="h-4 w-4 text-muted-foreground" />
              <input
                ref={inputRef}
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search devices, scripts, alerts, users, settings..."
                className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
              />
              <span className="rounded border px-2 py-0.5 text-[10px] font-semibold uppercase text-muted-foreground">
                Esc
              </span>
            </div>

            <div className="max-h-[60vh] overflow-y-auto">
              {isLoading && (
                <div className="flex items-center gap-2 px-4 py-3 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Searching...
                </div>
              )}

              {errorMessage && (
                <div className="px-4 py-3 text-sm text-destructive">
                  {errorMessage}
                </div>
              )}

              {!isLoading && sections.length === 0 && !showResults && (
                <div className="px-4 py-6 text-sm text-muted-foreground">
                  Start typing to search across devices, scripts, alerts, users, and settings.
                </div>
              )}

              {!isLoading &&
                sections.map((section) => (
                  <div key={section.id} className="border-t first:border-t-0">
                    <div className="flex items-center gap-2 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      <section.icon className="h-4 w-4" />
                      {section.label}
                    </div>
                    <div className="space-y-1 px-2 pb-2">
                      {section.items.map((item) => {
                        const isActive = item.key === activeItemKey;
                        const itemIndex = indexByKey.get(item.key) ?? -1;
                        return (
                          <button
                            key={item.key}
                            type="button"
                            onMouseEnter={() => {
                              if (itemIndex >= 0) {
                                setActiveIndex(itemIndex);
                              }
                            }}
                            onClick={() => handleSelectItem(item)}
                            className={cn(
                              'flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition',
                              isActive
                                ? 'bg-primary text-primary-foreground'
                                : 'hover:bg-muted'
                            )}
                          >
                            <item.icon
                              className={cn(
                                'h-4 w-4 flex-shrink-0',
                                isActive ? 'text-primary-foreground' : 'text-muted-foreground'
                              )}
                            />
                            <div className="min-w-0 flex-1">
                              <div className="truncate font-medium">{item.title}</div>
                              {item.description && (
                                <div
                                  className={cn(
                                    'truncate text-xs',
                                    isActive ? 'text-primary-foreground/80' : 'text-muted-foreground'
                                  )}
                                >
                                  {item.description}
                                </div>
                              )}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}

              {showResults && !isLoading && results.length === 0 && !errorMessage && (
                <div className="px-4 py-6 text-sm text-muted-foreground">
                  No results found. Try a different query.
                </div>
              )}
            </div>

            <div className="flex items-center justify-between border-t px-4 py-2 text-xs text-muted-foreground">
              <span>Use arrows to navigate, Enter to open</span>
              <span>Esc to close</span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
