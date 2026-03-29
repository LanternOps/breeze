import { useState, useEffect, useSyncExternalStore } from 'react';
import {
  LayoutDashboard,
  Monitor,
  FileCode,
  Bell,
  Terminal,
  FileText,
  Building,
  Building2,
  Filter,
  ListChecks,
  Users,
  ChevronLeft,
  ChevronRight,
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
  MessagesSquare
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface SidebarProps {
  currentPath?: string;
}

type SidebarMode = 'open' | 'hover' | 'collapsed';

// Track the current pathname reactively so persisted sidebar updates on View Transitions
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
  // Update after Astro View Transitions swap the DOM
  document.addEventListener('astro:after-swap', () => {
    pathListeners.forEach((cb) => cb());
  });
  // Also handle popstate for back/forward
  window.addEventListener('popstate', () => {
    pathListeners.forEach((cb) => cb());
  });
}

// --- Org-scoped sections (change with selected organization) ---

const coreNav = [
  { name: 'Dashboard', href: '/', icon: LayoutDashboard },
  { name: 'Devices', href: '/devices', icon: Monitor },
  { name: 'Alerts', href: '/alerts', icon: Bell },
  { name: 'Reports', href: '/reports', icon: FileText },
  { name: 'Analytics', href: '/analytics', icon: BarChart3 },
  { name: 'Fleet', href: '/fleet', icon: BrainCircuit },
  { name: 'AI Workspace', href: '/workspace', icon: MessagesSquare },
  { name: 'Remote Access', href: '/remote', icon: Terminal }
];

const securityNav = [
  { name: 'Network Monitor', href: '/monitoring', icon: Activity },
  { name: 'Security', href: '/security', icon: ShieldCheck },
  { name: 'Sensitive Data', href: '/sensitive-data', icon: ScanSearch },
  { name: 'Peripherals', href: '/peripherals', icon: Usb },
  { name: 'AI Risk Engine', href: '/ai-risk', icon: BrainCircuit },
  { name: 'CIS Benchmarks', href: '/cis-hardening', icon: ClipboardCheck },
  { name: 'Compliance Baselines', href: '/audit-baselines', icon: ListChecks },
];

const operationsNav = [
  { name: 'Scripts', href: '/scripts', icon: FileCode },
  { name: 'Patch Management', href: '/patches', icon: Download },
  { name: 'Network Discovery', href: '/discovery', icon: Network },
  { name: 'Software Library', href: '/software', icon: Package },
  { name: 'Software Policies', href: '/software-inventory', icon: Package },
  { name: 'Config Policies', href: '/configuration-policies', icon: Layers },
  { name: 'Backup', href: '/backup', icon: HardDrive },
  { name: 'Integrations', href: '/integrations', icon: Plug },
];

const reportingNav = [
  { name: 'Reports', href: '/reports', icon: FileText },
  { name: 'Analytics', href: '/analytics', icon: BarChart3 },
  { name: 'Audit Trail', href: '/audit', icon: FileText },
  { name: 'Event Logs', href: '/logs', icon: ScrollText },
];

const settingsNav = [
  { name: 'Org Settings', href: '/settings/organization', icon: Building },
  { name: 'AI Usage & Budget', href: '/settings/ai-usage', icon: BrainCircuit },
  { name: 'Custom Fields', href: '/settings/custom-fields', icon: ListChecks },
  { name: 'Saved Filters', href: '/settings/filters', icon: Filter },
];

// --- Partner-level (NOT org-dependent) ---

const adminNav = [
  { name: 'Organizations', href: '/settings/organizations', icon: Building2 },
  { name: 'Users', href: '/settings/users', icon: Users },
  { name: 'Roles', href: '/settings/roles', icon: KeyRound },
];

export default function Sidebar({ currentPath: initialPath = '/' }: SidebarProps) {
  const [mode, setMode] = useState<SidebarMode>('open');
  const [hovered, setHovered] = useState(false);
  const livePath = useSyncExternalStore(subscribeToPath, getPathSnapshot, getServerSnapshot);
  const currentPath = livePath || initialPath;

  // Persist mode in localStorage
  useEffect(() => {
    const saved = localStorage.getItem('sidebar-mode') as SidebarMode;
    if (saved && ['open', 'hover', 'collapsed'].includes(saved)) {
      setMode(saved);
    }
  }, []);

  const cycleMode = () => {
    const next: SidebarMode = mode === 'open' ? 'hover' : mode === 'hover' ? 'collapsed' : 'open';
    setMode(next);
    localStorage.setItem('sidebar-mode', next);
  };

  // Derived state
  const showLabels = mode === 'open' || (mode === 'hover' && hovered);
  const isNarrow = mode !== 'open';

  // Find the single most-specific matching href across all sections
  // so only one nav item highlights at a time
  const allNavItems = [
    ...coreNav, ...securityNav, ...operationsNav,
    ...reportingNav, ...settingsNav, ...adminNav,
  ];
  // Paths that should highlight a different nav item
  const pathAliases: Record<string, string> = {
    '/software-policies': '/software-inventory',
  };
  const resolvedPath = pathAliases[currentPath] ?? currentPath;

  const activeHref = (() => {
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
  })();

  const renderNavItem = (item: typeof coreNav[number]) => {
    const isActive = item.href === activeHref;
    return (
      <a
        key={item.name}
        href={item.href}
        title={isNarrow && !hovered ? item.name : undefined}
        className={cn(
          'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
          isActive
            ? 'bg-primary text-primary-foreground'
            : 'text-muted-foreground hover:bg-muted hover:text-foreground'
        )}
      >
        <item.icon className="h-5 w-5 flex-shrink-0" />
        {showLabels && <span className="truncate">{item.name}</span>}
      </a>
    );
  };

  const renderSection = (label: string, items: typeof coreNav) => (
    <>
      <div className="my-4 border-t" />
      {showLabels && (
        <span className="px-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">
          {label}
        </span>
      )}
      {items.map(renderNavItem)}
    </>
  );

  // Toggle button icon based on mode
  const ToggleIcon = mode === 'open' ? ChevronLeft : mode === 'hover' ? ChevronsLeft : ChevronRight;
  const toggleTitle = mode === 'open' ? 'Auto-hide sidebar' : mode === 'hover' ? 'Collapse sidebar' : 'Expand sidebar';

  const sidebarContent = (
    <aside
      className={cn(
        'flex h-full flex-col border-r bg-card transition-all duration-200',
        mode === 'hover' && 'absolute inset-y-0 left-0 z-20',
        mode === 'hover' && hovered && 'shadow-xl',
        showLabels ? 'w-64' : 'w-16'
      )}
      onMouseEnter={mode === 'hover' ? () => setHovered(true) : undefined}
      onMouseLeave={mode === 'hover' ? () => setHovered(false) : undefined}
    >
      <div className="flex h-16 items-center justify-between border-b px-4">
        {showLabels && (
          <span className="text-lg font-bold tracking-tight text-foreground">Breeze</span>
        )}
        <button
          onClick={cycleMode}
          title={toggleTitle}
          className="rounded-md p-1.5 hover:bg-muted"
        >
          <ToggleIcon className="h-5 w-5" />
        </button>
      </div>

      <nav className="flex-1 min-h-0 space-y-1 overflow-y-auto p-2">
        {coreNav.map(renderNavItem)}
        {renderSection('Security & Monitoring', securityNav)}
        {renderSection('Operations', operationsNav)}
        {renderSection('Reporting', reportingNav)}
        {renderSection('Settings', settingsNav)}
        {renderSection('Admin', adminNav)}
      </nav>
    </aside>
  );

  // In hover mode, wrap with a fixed-width spacer so content doesn't shift
  if (mode === 'hover') {
    return (
      <div className="relative w-16 flex-shrink-0">
        {sidebarContent}
      </div>
    );
  }

  return sidebarContent;
}
