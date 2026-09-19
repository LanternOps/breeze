import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bell,
  Clock,
  FileCode,
  Keyboard,
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
import { useTranslation } from 'react-i18next';
import { navigateTo } from '@/lib/navigation';
import { fetchWithAuth } from '../../stores/auth';
import { useUiStore } from '../../stores/uiStore';
import { useRecentsStore } from '../../stores/recentsStore';

type SearchCategory = 'devices' | 'scripts' | 'alerts' | 'users' | 'settings';

type SearchResult = {
  id?: string;
  type: SearchCategory;
  title: string;
  description?: string;
  href?: string;
};

type CommandItem = {
  key: string;
  title: string;
  description?: string;
  href?: string;
  /** Runs instead of navigating (e.g. open the shortcuts sheet). */
  onSelect?: () => void;
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

// Labels live under common.json `layout.search.actions.<id>` / `<id>Description`.
const QUICK_ACTIONS: Array<{
  key: string;
  id: 'newDevice' | 'runScript' | 'alertRules' | 'keyboardShortcuts';
  href?: string;
  icon: LucideIcon;
}> = [
  { key: 'action:new-device', id: 'newDevice', href: '/devices', icon: Plus },
  { key: 'action:run-script', id: 'runScript', href: '/scripts', icon: Terminal },
  { key: 'action:manage-config-policies', id: 'alertRules', href: '/configuration-policies', icon: Bell },
  { key: 'action:keyboard-shortcuts', id: 'keyboardShortcuts', icon: Keyboard }
];

// How many recents the empty state shows. The store keeps a few more pages so
// a typed query can still match something that scrolled off this list.
const PALETTE_RECENT_DEVICES = 5;
const PALETTE_RECENT_PAGES = 5;
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
  const { t } = useTranslation('common');
  // Open state lives in the ui store so the "/" shortcut (useGlobalShortcuts)
  // and any other island can open the same palette.
  const open = useUiStore((s) => s.isCommandPaletteOpen);
  const openPalette = useUiStore((s) => s.openCommandPalette);
  const closePalette = useUiStore((s) => s.closeCommandPalette);
  const togglePalette = useUiStore((s) => s.toggleCommandPalette);
  const openShortcutsHelp = useUiStore((s) => s.openShortcutsHelp);
  const recentDevices = useRecentsStore((s) => s.devices);
  const recentPages = useRecentsStore((s) => s.pages);
  const [modifierLabel, setModifierLabel] = useState('');
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const trimmedQuery = query.trim();
  const showQuickActions = trimmedQuery.length === 0;
  const showResults = trimmedQuery.length > 0;

  useEffect(() => {
    if (typeof navigator !== 'undefined') {
      setModifierLabel(/mac/i.test(navigator.platform) ? 'Cmd' : 'Ctrl');
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
    setIsLoading(true);
    setErrorMessage(null);
    // Drop the previous query's results now, not when the new ones land:
    // anything still in `results` stays keyboard-selectable, so it must not
    // be something the user can no longer see.
    setResults([]);

    const performSearch = async () => {
      try {
        const response = await fetchWithAuth(`/search?q=${encodeURIComponent(debouncedQuery)}`);
        if (!isActive) return;

        if (!response.ok) {
          // Auth errors mean an expired/absent session, not "no matches" — say
          // so explicitly instead of rendering the empty-results copy, which
          // would imply the data is gone.
          if (response.status === 401 || response.status === 403) {
            setResults([]);
            setErrorMessage('Your session expired. Sign in to search.');
            return;
          }
          throw new Error('Search failed');
        }

        const data = await response.json();
        setResults(normalizeResults(data));
      } catch (error: unknown) {
        if (!isActive) return;
        setResults([]);
        setErrorMessage('Unable to load search results.');
      } finally {
        if (!isActive) return;
        setIsLoading(false);
      }
    };

    performSearch();

    return () => {
      isActive = false;
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

  const handleSelectItem = useCallback(
    (item: CommandItem) => {
      // Close first: onSelect may open another overlay (the shortcuts sheet),
      // and the store's open* actions already close the palette — but an
      // explicit close keeps a plain navigation symmetrical.
      closePalette();
      if (item.onSelect) {
        item.onSelect();
        return;
      }
      if (item.href && typeof window !== 'undefined') {
        void navigateTo(item.href);
      }
    },
    [closePalette]
  );

  const quickActionItems = useMemo<CommandItem[]>(() => {
    return QUICK_ACTIONS.map((action) => ({
      key: action.key,
      title: t(/* i18n-dynamic */ `layout.search.actions.${action.id}`),
      description: t(/* i18n-dynamic */ `layout.search.actions.${action.id}Description`),
      href: action.href,
      onSelect: action.id === 'keyboardShortcuts' ? openShortcutsHelp : undefined,
      icon: action.icon,
      kind: 'action'
    }));
  }, [openShortcutsHelp, t]);

  // Recents come from the shared store (sidebar shows the same devices). Pages
  // carry their path as the description so two pages with one title (e.g. two
  // organizations, both titled "Organization") stay distinguishable.
  const recentDeviceItems = useMemo<CommandItem[]>(
    () =>
      recentDevices.map((device) => ({
        key: `recent-device:${device.id}`,
        title: device.name,
        href: `/devices/${device.id}`,
        icon: Monitor,
        kind: 'recent',
        category: 'devices'
      })),
    [recentDevices]
  );

  const recentPageItems = useMemo<CommandItem[]>(
    () =>
      recentPages.map((page) => ({
        key: `recent-page:${page.path}`,
        title: page.title,
        description: page.path,
        href: page.path,
        icon: Clock,
        kind: 'recent'
      })),
    [recentPages]
  );

  // Instant local matches while the server round-trip is still in flight.
  const localRecentMatches = useMemo<CommandItem[]>(() => {
    if (!trimmedQuery) return [];
    const needle = trimmedQuery.toLowerCase();
    const matches = (item: CommandItem) =>
      item.title.toLowerCase().includes(needle) ||
      (item.description?.toLowerCase().includes(needle) ?? false);
    return [...recentDeviceItems.filter(matches), ...recentPageItems.filter(matches)];
  }, [recentDeviceItems, recentPageItems, trimmedQuery]);

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
      // Most recent first so Cmd+K, Enter is "take me back to what I was doing".
      pushSection({
        id: 'recent-devices',
        label: 'Recent devices',
        icon: Monitor,
        items: recentDeviceItems.slice(0, PALETTE_RECENT_DEVICES)
      });
      pushSection({
        id: 'recent-pages',
        label: 'Recently visited',
        icon: Clock,
        items: recentPageItems.slice(0, PALETTE_RECENT_PAGES)
      });
      pushSection({
        id: 'quick-actions',
        label: 'Quick actions',
        icon: Zap,
        items: quickActionItems
      });
    }

    if (showResults) {
      pushSection({
        id: 'recent',
        label: 'Recent',
        icon: Clock,
        items: localRecentMatches
      });
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
    localRecentMatches,
    quickActionItems,
    recentDeviceItems,
    recentPageItems,
    resultItemsByCategory,
    showQuickActions,
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
        togglePalette();
      }
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, [togglePalette]);

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
        closePalette();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeIndex, closePalette, handleSelectItem, open, selectableItems]);

  return (
    <>
      {/* Compact icon trigger on phones (no physical keyboard, space is tight);
          the full search bar takes over at sm+. Both open the same palette. */}
      <button
        type="button"
        onClick={openPalette}
        className="flex h-9 w-9 items-center justify-center rounded-md border bg-background text-muted-foreground hover:bg-muted/40 focus:outline-hidden focus:ring-2 focus:ring-ring xl:hidden"
        aria-label={t('actions.search')}
      >
        <Search className="h-4 w-4 shrink-0" />
      </button>
      <button
        type="button"
        onClick={openPalette}
        className="hidden h-9 w-full min-w-0 items-center gap-2 rounded-md border bg-background px-3 text-sm text-muted-foreground hover:bg-muted/40 focus:outline-hidden focus:ring-2 focus:ring-ring xl:flex"
        aria-label={t('actions.search')}
      >
        <Search className="h-4 w-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate whitespace-nowrap text-left">{t('layout.search.prompt')}</span>
        <span className="shrink-0 rounded border bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase text-muted-foreground">
          {modifierLabel ? `${modifierLabel}+K` : 'K'}
        </span>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-background/80 px-4 py-8"
          onClick={closePalette}
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
                placeholder={t('layout.search.placeholder')}
                className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-hidden"
              />
              <span className="rounded border px-2 py-0.5 text-[10px] font-semibold uppercase text-muted-foreground">
                Esc
              </span>
            </div>

            <div className="max-h-[60vh] overflow-y-auto">
              {isLoading && (
                <div className="flex items-center gap-2 px-4 py-3 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t('layout.search.searching')}
                </div>
              )}

              {errorMessage && (
                <div className="px-4 py-3 text-sm text-destructive">
                  {errorMessage}
                </div>
              )}

              {!isLoading && sections.length === 0 && !showResults && (
                <div className="px-4 py-6 text-sm text-muted-foreground">
                  {t('layout.search.startTyping')}
                </div>
              )}

              {/* Rendered while loading too: local recent matches are already
                  selectable, so they must stay visible under the spinner. */}
              {sections.map((section) => (
                  <div key={section.id} data-testid={`palette-section-${section.id}`} className="border-t first:border-t-0">
                    <div
                      data-testid="palette-section-heading"
                      className="flex items-center gap-2 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                    >
                      <section.icon className="h-4 w-4" />
                      {t(/* i18n-dynamic */ `layout.search.sections.${section.id}`, { defaultValue: section.label })}
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
                                'h-4 w-4 shrink-0',
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
                  {t('layout.search.noResults')}
                </div>
              )}
            </div>

            <div className="flex items-center justify-between border-t px-4 py-2 text-xs text-muted-foreground">
              <span>{t('layout.search.navigationHint')}</span>
              <span>{t('layout.search.closeHint')}</span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
