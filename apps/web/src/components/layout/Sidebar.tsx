import { useState, useCallback, useMemo, useEffect, useSyncExternalStore } from 'react';
import {
  LayoutDashboard,
  Monitor,
  FileCode,
  Bell,
  ShieldAlert,
  Terminal,
  FileText,
  Building,
  Building2,
  Filter,
  ListChecks,
  Users,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronsLeft,
  ShieldCheck,
  KeyRound,
  Package,
  Plug,
  Network,
  HardDrive,
  BarChart3,
  BrainCircuit,
  Activity,
  Layers,
  ScrollText,
  Download,
  ClipboardCheck,
  ScanSearch,
  Usb,
  MessagesSquare,
  Key,
  X,
  Cloud,
  ShieldEllipsis,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useUiStore } from '../../stores/uiStore';
import { fetchWithAuth } from '../../stores/auth';
import { WEB_VERSION } from '../../lib/version';

interface SidebarProps {
  currentPath?: string;
}

type SidebarMode = 'open' | 'hover' | 'collapsed';

// ---------------------------------------------------------------------------
// Path tracking (reactive across Astro View Transitions)
// ---------------------------------------------------------------------------
let pathListeners = new Set<() => void>();
function subscribeToPath(cb: () => void) {
  pathListeners.add(cb);
  return () => { pathListeners.delete(cb); };
}
function getPathSnapshot() {
  return typeof window !== 'undefined' ? window.location.pathname : '/';
}
function getServerSnapshot() {
  return '/';
}
if (typeof window !== 'undefined') {
  document.addEventListener('astro:after-swap', () => {
    pathListeners.forEach((cb) => cb());
  });
  window.addEventListener('popstate', () => {
    pathListeners.forEach((cb) => cb());
  });
}

// ---------------------------------------------------------------------------
// Nav item type
// ---------------------------------------------------------------------------
type NavItem = { name: string; href: string; icon: React.ComponentType<{ className?: string }> };

// ---------------------------------------------------------------------------
// Top-level items (always visible, 6-8 max)
// ---------------------------------------------------------------------------
const topLevelNav: NavItem[] = [
  { name: 'Dashboard', href: '/', icon: LayoutDashboard },
  { name: 'Devices', href: '/devices', icon: Monitor },
  { name: 'Alerts', href: '/alerts', icon: Bell },
  { name: 'Incidents', href: '/incidents', icon: ShieldAlert },
  { name: 'Remote Access', href: '/remote', icon: Terminal },
  { name: 'Scripts', href: '/scripts', icon: FileCode },
  { name: 'Patches', href: '/patches', icon: Download },
];

// ---------------------------------------------------------------------------
// Collapsible section definitions
// ---------------------------------------------------------------------------
interface NavSection {
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  items: NavItem[];
}

const navSections: NavSection[] = [
  {
    id: 'ai-fleet',
    label: 'AI & Fleet',
    icon: BrainCircuit,
    items: [
      { name: 'Fleet', href: '/fleet', icon: BrainCircuit },
      { name: 'AI Workspace', href: '/workspace', icon: MessagesSquare },
    ],
  },
  {
    id: 'security',
    label: 'Security',
    icon: ShieldCheck,
    items: [
      { name: 'Network Monitor', href: '/monitoring', icon: Activity },
      { name: 'Security', href: '/security', icon: ShieldCheck },
      { name: 'Sensitive Data', href: '/sensitive-data', icon: ScanSearch },
      { name: 'Peripherals', href: '/peripherals', icon: Usb },
      { name: 'AI Risk Engine', href: '/ai-risk', icon: BrainCircuit },
      { name: 'CIS Benchmarks', href: '/cis-hardening', icon: ClipboardCheck },
      { name: 'Compliance Baselines', href: '/audit-baselines', icon: ListChecks },
    ],
  },
  {
    id: 'operations',
    label: 'Operations',
    icon: Layers,
    items: [
      { name: 'Network Discovery', href: '/discovery', icon: Network },
      { name: 'Software Library', href: '/software', icon: Package },
      { name: 'Software Policies', href: '/software-inventory', icon: Package },
      { name: 'Config Policies', href: '/configuration-policies', icon: Layers },
      { name: 'Backup', href: '/backup', icon: HardDrive },
      { name: 'Cloud Backup', href: '/c2c', icon: Cloud },
      { name: 'Disaster Recovery', href: '/dr', icon: ShieldEllipsis },
      { name: 'Integrations', href: '/integrations', icon: Plug },
    ],
  },
  {
    id: 'reporting',
    label: 'Reporting',
    icon: BarChart3,
    items: [
      { name: 'Reports', href: '/reports', icon: FileText },
      { name: 'Analytics', href: '/analytics', icon: BarChart3 },
      { name: 'Audit Trail', href: '/audit', icon: FileText },
      { name: 'Event Logs', href: '/logs', icon: ScrollText },
    ],
  },
  {
    id: 'settings',
    label: 'Settings',
    icon: Building,
    items: [
      { name: 'Org Settings', href: '/settings/organization', icon: Building },
      { name: 'AI Usage & Budget', href: '/settings/ai-usage', icon: BrainCircuit },
      { name: 'Custom Fields', href: '/settings/custom-fields', icon: ListChecks },
      { name: 'Saved Filters', href: '/settings/filters', icon: Filter },
      { name: 'Organizations', href: '/settings/organizations', icon: Building2 },
      { name: 'Users', href: '/settings/users', icon: Users },
      { name: 'Roles', href: '/settings/roles', icon: KeyRound },
      { name: 'Enrollment Keys', href: '/settings/enrollment-keys', icon: Key },
    ],
  },
];

// ---------------------------------------------------------------------------
// Helpers: localStorage for sidebar mode & section collapse state
// ---------------------------------------------------------------------------
function readSavedMode(): SidebarMode {
  if (typeof window === 'undefined') return 'open';
  try {
    const saved = localStorage.getItem('sidebar-mode') as SidebarMode;
    if (saved && ['open', 'hover', 'collapsed'].includes(saved)) return saved;
  } catch { /* Storage unavailable */ }
  return 'open';
}

function readExpandedSections(): Record<string, boolean> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem('sidebar-sections');
    if (raw) return JSON.parse(raw);
  } catch { /* Storage unavailable */ }
  return {};
}

function saveExpandedSections(state: Record<string, boolean>) {
  try { localStorage.setItem('sidebar-sections', JSON.stringify(state)); } catch { /* Storage unavailable */ }
}

// ---------------------------------------------------------------------------
// Collect all nav items for active-href matching
// ---------------------------------------------------------------------------
const allNavItems: NavItem[] = [
  ...topLevelNav,
  ...navSections.flatMap((s) => s.items),
];

// Path aliases (highlight a different nav item for certain paths)
const pathAliases: Record<string, string> = {
  '/software-policies': '/software-inventory',
};

// Determine which section a given href belongs to (for auto-expand)
function sectionForHref(href: string): string | null {
  for (const section of navSections) {
    for (const item of section.items) {
      if (item.href === href) return section.id;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function Sidebar({ currentPath: initialPath = '/' }: SidebarProps) {
  const [mode, setMode] = useState<SidebarMode>(readSavedMode);
  const [hovered, setHovered] = useState(false);
  const livePath = useSyncExternalStore(subscribeToPath, getPathSnapshot, getServerSnapshot);
  const currentPath = livePath || initialPath;

  // --- Responsive breakpoints -----------------------------------------------
  // Track whether viewport is below lg (1024px) or md (768px) to override mode
  const [isTablet, setIsTablet] = useState(false);  // < 1024px
  const [isMobile, setIsMobile] = useState(false);   // < 768px
  const { isMobileMenuOpen, closeMobileMenu } = useUiStore();

  // Fetch API version once
  const [apiVersion, setApiVersion] = useState<string | null>(null);
  useEffect(() => {
    fetchWithAuth('/system/version')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: { version: string }) => setApiVersion(data.version))
      .catch((err) => {
        console.warn('[Sidebar] Failed to fetch API version:', err);
        setApiVersion('unavailable');
      });
  }, []);

  useEffect(() => {
    const mqTablet = window.matchMedia('(max-width: 1023px)');
    const mqMobile = window.matchMedia('(max-width: 767px)');

    const handleTablet = (e: MediaQueryListEvent | MediaQueryList) => setIsTablet(e.matches);
    const handleMobile = (e: MediaQueryListEvent | MediaQueryList) => setIsMobile(e.matches);

    // Set initial values
    handleTablet(mqTablet);
    handleMobile(mqMobile);

    mqTablet.addEventListener('change', handleTablet);
    mqMobile.addEventListener('change', handleMobile);

    return () => {
      mqTablet.removeEventListener('change', handleTablet);
      mqMobile.removeEventListener('change', handleMobile);
    };
  }, []);

  // Close mobile menu on navigation (Astro View Transitions)
  useEffect(() => {
    const handleNav = () => closeMobileMenu();
    document.addEventListener('astro:after-swap', handleNav);
    return () => document.removeEventListener('astro:after-swap', handleNav);
  }, [closeMobileMenu]);

  // Compute the effective mode: on tablet force collapsed, on mobile hide entirely
  const effectiveMode: SidebarMode = isMobile ? 'collapsed' : isTablet ? 'collapsed' : mode;

  // --- Derived state -------------------------------------------------------
  const showLabels = effectiveMode === 'open' || (effectiveMode === 'hover' && hovered);
  const isNarrow = effectiveMode !== 'open';

  // Find the best matching active href
  const resolvedPath = pathAliases[currentPath] ?? currentPath;
  const activeHref = useMemo(() => {
    let best: string | null = null;
    for (const item of allNavItems) {
      const matches = item.href === '/'
        ? resolvedPath === '/'
        : resolvedPath === item.href || resolvedPath.startsWith(item.href + '/');
      if (matches && (!best || item.href.length > best.length)) {
        best = item.href;
      }
    }
    return best;
  }, [resolvedPath]);

  // Auto-expand: the section containing the active page should be expanded
  const activeSectionId = activeHref ? sectionForHref(activeHref) : null;

  // --- Expanded sections state (with auto-expand for active page) ----------
  // Start empty to match server render; hydrate from localStorage in effect
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const saved = readExpandedSections();
    if (Object.keys(saved).length > 0) setExpandedSections(saved);
  }, []);

  const toggleSection = useCallback((sectionId: string) => {
    setExpandedSections((prev) => {
      // Determine current effective state: explicit toggle takes precedence, then auto-expand
      const currentlyExpanded = sectionId in prev ? prev[sectionId] : sectionId === activeSectionId;
      const next = { ...prev, [sectionId]: !currentlyExpanded };
      saveExpandedSections(next);
      return next;
    });
  }, [activeSectionId]);

  // --- Sidebar mode cycling ------------------------------------------------
  const cycleMode = () => {
    const next: SidebarMode = mode === 'open' ? 'hover' : mode === 'hover' ? 'collapsed' : 'open';
    setMode(next);
    try { localStorage.setItem('sidebar-mode', next); } catch { /* Storage unavailable */ }
  };

  // Determine if a section is expanded (explicit toggle OR auto-expand)
  const isSectionExpanded = useCallback((sectionId: string): boolean => {
    // If user has explicitly toggled this section, respect that
    if (sectionId in expandedSections) return expandedSections[sectionId];
    // Otherwise auto-expand if it contains the active page
    return sectionId === activeSectionId;
  }, [expandedSections, activeSectionId]);

  // --- Render a single nav item -------------------------------------------
  const renderNavItem = (item: NavItem, forMobileOverlay = false) => {
    const isActive = item.href === activeHref;
    const labels = forMobileOverlay ? true : showLabels;
    const narrow = forMobileOverlay ? false : isNarrow;
    return (
      <a
        key={item.name}
        href={item.href}
        title={narrow && !hovered ? item.name : undefined}
        onClick={forMobileOverlay ? () => closeMobileMenu() : undefined}
        className={cn(
          'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
          isActive
            ? 'bg-primary text-primary-foreground'
            : 'text-muted-foreground hover:bg-muted hover:text-foreground'
        )}
      >
        <item.icon className="h-5 w-5 flex-shrink-0" />
        {labels && <span className="truncate">{item.name}</span>}
      </a>
    );
  };

  // --- Render a collapsible section ----------------------------------------
  const renderCollapsibleSection = (section: NavSection, forMobileOverlay = false) => {
    const expanded = isSectionExpanded(section.id);
    const labels = forMobileOverlay ? true : showLabels;

    return (
      <div key={section.id}>
        <div className="my-2 border-t" />
        {/* In collapsed mode (no labels), show only the section icon */}
        {!labels ? (
          <div className="flex justify-center py-1.5">
            <section.icon className="h-4 w-4 text-muted-foreground/70" />
          </div>
        ) : (
          <button
            onClick={() => toggleSection(section.id)}
            className="flex items-center justify-between w-full px-2 py-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground/70 hover:text-muted-foreground cursor-pointer transition-colors"
            style={{ fontSize: '12px' }}
          >
            <span>{section.label}</span>
            <ChevronDown
              className={cn(
                'h-3.5 w-3.5 transition-transform duration-200',
                expanded ? 'rotate-0' : '-rotate-90'
              )}
            />
          </button>
        )}
        {/* Animated expand/collapse container */}
        {labels && (
          <div
            className={cn(
              'nav-section-content',
              expanded && 'nav-section-expanded'
            )}
            aria-hidden={!expanded}
            inert={!expanded || undefined}
          >
            <div>
              {section.items.map((item) => renderNavItem(item, forMobileOverlay))}
            </div>
          </div>
        )}
        {/* In collapsed mode, show nothing for children */}
      </div>
    );
  };

  // --- Toggle button icon --------------------------------------------------
  const ToggleIcon = effectiveMode === 'open' ? ChevronLeft : effectiveMode === 'hover' ? ChevronsLeft : ChevronRight;
  const toggleTitle = effectiveMode === 'open' ? 'Auto-hide sidebar' : effectiveMode === 'hover' ? 'Collapse sidebar' : 'Expand sidebar';

  // --- Shared CSS for expand/collapse animation ----------------------------
  const sectionAnimCss = (
    <style>{`
      .nav-section-content {
        display: grid;
        grid-template-rows: 0fr;
        transition: grid-template-rows 200ms ease-out;
      }
      .nav-section-content.nav-section-expanded {
        grid-template-rows: 1fr;
      }
      .nav-section-content > div {
        overflow: hidden;
      }
    `}</style>
  );

  // --- Desktop sidebar shell -----------------------------------------------
  const sidebarContent = (
    <aside
      className={cn(
        'flex h-full flex-col border-r bg-card transition-all duration-200',
        // Hide completely on mobile — the overlay handles it
        isMobile && 'hidden',
        effectiveMode === 'hover' && 'absolute inset-y-0 left-0 z-20',
        effectiveMode === 'hover' && hovered && 'shadow-xl',
        showLabels ? 'w-64' : 'w-16'
      )}
      onMouseEnter={effectiveMode === 'hover' ? () => setHovered(true) : undefined}
      onMouseLeave={effectiveMode === 'hover' ? () => setHovered(false) : undefined}
    >
      {sectionAnimCss}

      <div className="flex h-16 items-center justify-between border-b px-4">
        <div className="flex items-center gap-2">
          <div className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[6px] bg-primary/15">
            <svg width="14" height="14" viewBox="0 0 64 64" fill="none" className="text-primary">
              <path d="M12 22C12 22 20 22 28 22C36 22 40 16 48 16C52 16 54 18 54 20C54 22 52 24 48 24C44 24 42 22 42 22" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M8 34C8 34 18 34 30 34C42 34 46 28 52 28C55 28 57 30 57 32C57 34 55 36 52 36C48 36 46 34 46 34" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M14 46C14 46 22 46 32 46C40 46 44 40 50 40C53 40 55 42 55 44C55 46 53 48 50 48C46 48 44 46 44 46" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          {showLabels && (
            <span className="text-lg font-bold tracking-tight text-foreground">Breeze</span>
          )}
        </div>
        {/* Only show mode toggle on non-tablet viewports */}
        {!isTablet && (
          <button
            onClick={cycleMode}
            title={toggleTitle}
            className="rounded-md p-1.5 hover:bg-muted"
          >
            <ToggleIcon className="h-5 w-5" />
          </button>
        )}
      </div>

      <nav data-tour="sidebar-nav" className="sidebar-nav flex-1 min-h-0 space-y-1 overflow-y-auto p-2" style={{ scrollbarGutter: 'stable' }}>
        {topLevelNav.map((item) => renderNavItem(item))}
        {navSections.map((section) => renderCollapsibleSection(section))}
      </nav>

      {showLabels && (
        <div className="border-t px-4 py-2 text-[10px] text-muted-foreground/50">
          <p>Web {WEB_VERSION}{apiVersion ? ` · API ${apiVersion}` : ''}</p>
        </div>
      )}
    </aside>
  );

  // --- Mobile overlay sidebar ----------------------------------------------
  const mobileOverlay = isMobile && isMobileMenuOpen && (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-background/80 backdrop-blur-sm"
        onClick={closeMobileMenu}
      />
      {/* Slide-out sidebar */}
      <aside className="fixed inset-y-0 left-0 z-50 w-64 bg-card border-r shadow-lg overflow-y-auto">
        {sectionAnimCss}

        <div className="flex h-16 items-center justify-between border-b px-4">
          <div className="flex items-center gap-2">
            <div className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[6px] bg-primary/15">
              <svg width="14" height="14" viewBox="0 0 64 64" fill="none" className="text-primary">
                <path d="M12 22C12 22 20 22 28 22C36 22 40 16 48 16C52 16 54 18 54 20C54 22 52 24 48 24C44 24 42 22 42 22" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M8 34C8 34 18 34 30 34C42 34 46 28 52 28C55 28 57 30 57 32C57 34 55 36 52 36C48 36 46 34 46 34" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M14 46C14 46 22 46 32 46C40 46 44 40 50 40C53 40 55 42 55 44C55 46 53 48 50 48C46 48 44 46 44 46" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <span className="text-lg font-bold tracking-tight text-foreground">Breeze</span>
          </div>
          <button
            onClick={closeMobileMenu}
            className="rounded-md p-1.5 hover:bg-muted"
            title="Close menu"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <nav className="sidebar-nav flex-1 min-h-0 space-y-1 overflow-y-auto p-2">
          {topLevelNav.map((item) => renderNavItem(item, true))}
          {navSections.map((section) => renderCollapsibleSection(section, true))}
        </nav>
      </aside>
    </>
  );

  // --- Final render --------------------------------------------------------

  // On mobile, render only the overlay (no desktop sidebar at all)
  if (isMobile) {
    return <>{mobileOverlay}</>;
  }

  // In hover mode, wrap with a fixed-width spacer so content doesn't shift
  if (effectiveMode === 'hover') {
    return (
      <div className="relative w-16 flex-shrink-0">
        {sidebarContent}
      </div>
    );
  }

  return sidebarContent;
}
