import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  LayoutDashboard,
  Monitor,
  FileCode,
  Bell,
  ShieldAlert,
  Terminal,
  FileText,
  FileSignature,
  Receipt,
  Tags,
  FileSpreadsheet,
  Building,
  Building2,
  Filter,
  ListChecks,
  Users,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronsLeft,
  ChevronsDownUp,
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
  Ticket,
  Key,
  X,
  Cloud,
  ShieldEllipsis,
  UserCheck,
  UserX,
  Fingerprint,
  FileCheck,
  Clock,
  Ban,
  Boxes,
  Bug,
  Puzzle,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useUiStore } from '../../stores/uiStore';
import type { PermissionGrant } from '@breeze/shared';
import { fetchWithAuth, useAuthStore } from '../../stores/auth';
import { hasPermission } from '../../lib/permissions';
import { WEB_VERSION } from '../../lib/version';
import { semverCompare } from '@breeze/shared';
import { getJwtClaims } from '../../lib/authScope';
import BrandHeader from './BrandHeader';
import { ENABLE_EDR_INTEGRATIONS } from '../../lib/featureFlags';
import { useExtensionNavigation } from '../extensions/useExtensionNavigation';
import '../../lib/i18n';

interface SidebarProps {
  currentPath?: string;
}

type SidebarMode = 'open' | 'hover' | 'collapsed';

// ---------------------------------------------------------------------------
// Path tracking (reactive across Astro View Transitions)
// ---------------------------------------------------------------------------
// useEffect-based: cleaned up on unmount, schedules normal async React updates
// so it can't conflict with concurrent island hydration (unlike useSyncExternalStore
// which forces SyncLane renders that can clear the dispatcher mid-transition).
function useCurrentPath(initialPath: string): string {
  const [path, setPath] = useState(initialPath);
  useEffect(() => {
    const update = () => setPath(window.location.pathname);
    document.addEventListener('astro:after-swap', update);
    window.addEventListener('popstate', update);
    return () => {
      document.removeEventListener('astro:after-swap', update);
      window.removeEventListener('popstate', update);
    };
  }, []);
  return path;
}

// ---------------------------------------------------------------------------
// Sidebar scroll-position persistence across Astro View Transitions
// ---------------------------------------------------------------------------
// The sidebar island is rendered with `transition:persist`, but the scrollable
// nested `<nav>` is not covered by Astro's viewport-level scroll restoration —
// it lands back at scrollTop=0 after every swap (#1714). We capture the live
// scrollTop on `astro:before-swap` and reapply it on `astro:after-swap` so the
// item the user just clicked (and its neighbours) stay in view.
//
// Returns a ref to attach to the scrollable `<nav>`. The captured value lives in
// a per-instance `useRef` (not module state or storage), so it survives the swap
// without persisting anywhere.
function useSidebarScrollPersist(): React.RefObject<HTMLElement | null> {
  const navRef = useRef<HTMLElement | null>(null);
  const savedScrollTop = useRef<number | null>(null);

  useEffect(() => {
    const save = () => {
      if (navRef.current) savedScrollTop.current = navRef.current.scrollTop;
    };
    const restore = () => {
      // The persisted island re-renders during the swap; restore after the new
      // DOM is in place. A pending value of 0 is still a real position (user
      // scrolled to the top) so we only skip when nothing was captured.
      if (navRef.current && savedScrollTop.current !== null) {
        navRef.current.scrollTop = savedScrollTop.current;
      }
    };
    document.addEventListener('astro:before-swap', save);
    document.addEventListener('astro:after-swap', restore);
    return () => {
      document.removeEventListener('astro:before-swap', save);
      document.removeEventListener('astro:after-swap', restore);
    };
  }, []);

  return navRef;
}

// ---------------------------------------------------------------------------
// Nav item type
// ---------------------------------------------------------------------------
type NavItem = {
  name: string;
  labelKey?: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  badgeKind?: 'deletion-requests';
  // Hidden unless the current user is a platform admin. Keeps cross-tenant
  // platform-operator nav (and its badge fetch) out of ordinary users' UI.
  platformAdminOnly?: boolean;
  // Hidden when the JWT decodes to a non-partner scope (AI for Office is an
  // MSP-admin surface). Client-side UX nicety only — same rationale as the
  // partner-branding fetch below; undecodable tokens fall through to visible
  // and the server re-checks everything.
  partnerScopeOnly?: boolean;
  // Shown only when the current partner has AI for Office enabled (runtime flag
  // from /orgs/partners/me). Undefined means not gated on the partner flag.
  requiresAiForOffice?: boolean;
  // Hidden unless the user holds this permission (e.g. billing nav gated on
  // invoices:read). UX only — the route still enforces it server-side. While
  // the permission set is still loading, the item stays hidden. Typed as the
  // exact-pair union so a typo'd resource/action fails to compile.
  requiredPermission?: PermissionGrant;
};

// ---------------------------------------------------------------------------
// Top-level items (always visible, 6-8 max)
// ---------------------------------------------------------------------------
// Each item maps to the permission its backing route enforces (see the
// requirePermission calls in apps/api/src/routes/*). Gating the nav on the same
// grant keeps a permission-scoped role (e.g. "Partner Billing", which holds only
// catalog/invoices/quotes/contracts) from seeing items it has no access to.
// Dashboard is ungated — it's the always-available landing page.
export const topLevelNav: NavItem[] = [
  { name: 'Dashboard', labelKey: 'nav.dashboard', href: '/', icon: LayoutDashboard },
  { name: 'Devices', labelKey: 'nav.devices', href: '/devices', icon: Monitor, requiredPermission: { resource: 'devices', action: 'read' } },
  { name: 'Alerts', labelKey: 'nav.alerts', href: '/alerts', icon: Bell, requiredPermission: { resource: 'alerts', action: 'read' } },
  { name: 'Tickets', labelKey: 'nav.tickets', href: '/tickets', icon: Ticket, requiredPermission: { resource: 'tickets', action: 'read' } },
  { name: 'Incidents', labelKey: 'nav.incidents', href: '/incidents', icon: ShieldAlert, requiredPermission: { resource: 'alerts', action: 'read' } },
  { name: 'Remote Access', labelKey: 'nav.remoteAccess', href: '/remote', icon: Terminal, requiredPermission: { resource: 'remote', action: 'access' } },
  { name: 'Scripts', labelKey: 'nav.scripts', href: '/scripts', icon: FileCode, requiredPermission: { resource: 'scripts', action: 'read' } },
  { name: 'Patches', labelKey: 'nav.patches', href: '/patches', icon: Download, requiredPermission: { resource: 'devices', action: 'read' } },
  { name: 'Vulnerabilities', labelKey: 'nav.vulnerabilities', href: '/vulnerabilities', icon: Bug, requiredPermission: { resource: 'devices', action: 'read' } },
  { name: 'OneDrive', labelKey: 'nav.oneDrive', href: '/onedrive', icon: Cloud, requiredPermission: { resource: 'devices', action: 'read' } },
];

// ---------------------------------------------------------------------------
// Collapsible section definitions
// ---------------------------------------------------------------------------
interface NavSection {
  id: string;
  label: string;
  labelKey?: string;
  icon: React.ComponentType<{ className?: string }>;
  items: NavItem[];
}

// Exported for structural nav tests (see Sidebar.nav.test.tsx).
export const navSections: NavSection[] = [
  {
    id: 'ai-fleet',
    label: 'AI & Fleet',
    labelKey: 'nav.sectionAiFleet',
    icon: BrainCircuit,
    items: [
      { name: 'Fleet', labelKey: 'nav.fleet', href: '/fleet', icon: BrainCircuit },
      { name: 'AI Workspace', labelKey: 'nav.aiWorkspace', href: '/workspace', icon: MessagesSquare },
      { name: 'AI for Office', labelKey: 'nav.aiForOffice', href: '/ai-for-office', icon: FileSpreadsheet, partnerScopeOnly: true, requiresAiForOffice: true },
    ],
  },
  {
    id: 'monitoring',
    label: 'Monitoring',
    labelKey: 'nav.sectionMonitoring',
    icon: Activity,
    // Both surfaces read device/network state, gated on devices:read server-side.
    items: [
      { name: 'Network Monitor', labelKey: 'nav.networkMonitor', href: '/monitoring', icon: Activity, requiredPermission: { resource: 'devices', action: 'read' } },
      { name: 'Network Discovery', labelKey: 'nav.networkDiscovery', href: '/discovery', icon: Network, requiredPermission: { resource: 'devices', action: 'read' } },
    ],
  },
  {
    id: 'security',
    label: 'Security',
    labelKey: 'nav.sectionSecurity',
    icon: ShieldCheck,
    // The security suite is built on device posture/scan data (devices:read).
    // A billing-only role has no devices:read grant, so the whole section hides.
    items: [
      { name: 'Security', labelKey: 'nav.security', href: '/security', icon: ShieldCheck, requiredPermission: { resource: 'devices', action: 'read' } },
      ...(ENABLE_EDR_INTEGRATIONS
        ? [{ name: 'EDR', labelKey: 'nav.edr', href: '/security/edr', icon: ShieldAlert, requiredPermission: { resource: 'devices', action: 'read' } } satisfies NavItem]
        : []),
      { name: 'DNS Security', labelKey: 'nav.dnsSecurity', href: '/dns-security', icon: Network, requiredPermission: { resource: 'devices', action: 'read' } },
      { name: 'PAM', labelKey: 'nav.pam', href: '/pam', icon: KeyRound, requiredPermission: { resource: 'devices', action: 'read' } },
      { name: 'User Risk', labelKey: 'nav.userRisk', href: '/security/user-risk', icon: UserCheck, requiredPermission: { resource: 'devices', action: 'read' } },
      { name: 'Sensitive Data', labelKey: 'nav.sensitiveData', href: '/sensitive-data', icon: ScanSearch, requiredPermission: { resource: 'devices', action: 'read' } },
      { name: 'Peripherals', labelKey: 'nav.peripherals', href: '/peripherals', icon: Usb, requiredPermission: { resource: 'devices', action: 'read' } },
      { name: 'AI Risk Engine', labelKey: 'nav.aiRiskEngine', href: '/ai-risk', icon: BrainCircuit, requiredPermission: { resource: 'devices', action: 'read' } },
      { name: 'CIS Benchmarks', labelKey: 'nav.cisBenchmarks', href: '/cis-hardening', icon: ClipboardCheck, requiredPermission: { resource: 'devices', action: 'read' } },
      { name: 'Compliance Baselines', labelKey: 'nav.complianceBaselines', href: '/audit-baselines', icon: ListChecks, requiredPermission: { resource: 'devices', action: 'read' } },
    ],
  },
  {
    id: 'operations',
    label: 'Operations',
    labelKey: 'nav.sectionOperations',
    icon: Layers,
    items: [
      { name: 'Quotes', labelKey: 'nav.quotes', href: '/billing/quotes', icon: FileText, partnerScopeOnly: true, requiredPermission: { resource: 'quotes', action: 'read' } },
      { name: 'Invoices', labelKey: 'nav.invoices', href: '/billing/invoices', icon: Receipt, partnerScopeOnly: true, requiredPermission: { resource: 'invoices', action: 'read' } },
      { name: 'Contracts', labelKey: 'nav.contracts', href: '/contracts', icon: FileSignature, partnerScopeOnly: true, requiredPermission: { resource: 'contracts', action: 'read' } },
      { name: 'Timesheets', labelKey: 'nav.timesheets', href: '/timesheet', icon: Clock, requiredPermission: { resource: 'time_entries', action: 'read' } },
      { name: 'Product Catalog', labelKey: 'nav.productCatalog', href: '/settings/catalog', icon: Tags, partnerScopeOnly: true, requiredPermission: { resource: 'catalog', action: 'read' } },
      { name: 'Software Library', labelKey: 'nav.softwareLibrary', href: '/software', icon: Package, requiredPermission: { resource: 'devices', action: 'read' } },
      { name: 'Software Policies', labelKey: 'nav.softwarePolicies', href: '/software-inventory', icon: Package, requiredPermission: { resource: 'devices', action: 'read' } },
      { name: 'Config Policies', labelKey: 'nav.configPolicies', href: '/configuration-policies', icon: Layers, requiredPermission: { resource: 'devices', action: 'read' } },
      { name: 'Integrations', labelKey: 'nav.integrations', href: '/integrations', icon: Plug },
    ],
  },
  {
    id: 'backup',
    label: 'Backup',
    labelKey: 'nav.sectionBackup',
    icon: HardDrive,
    // Backup/recovery surfaces are gated on the backup:read grant.
    items: [
      { name: 'Backup', labelKey: 'nav.backup', href: '/backup', icon: HardDrive, requiredPermission: { resource: 'backup', action: 'read' } },
      { name: 'Cloud Backup', labelKey: 'nav.cloudBackup', href: '/c2c', icon: Cloud, requiredPermission: { resource: 'backup', action: 'read' } },
      { name: 'Disaster Recovery', labelKey: 'nav.disasterRecovery', href: '/dr', icon: ShieldEllipsis, requiredPermission: { resource: 'backup', action: 'read' } },
    ],
  },
  {
    id: 'reporting',
    label: 'Reporting',
    labelKey: 'nav.sectionReporting',
    icon: BarChart3,
    items: [
      { name: 'Reports', labelKey: 'nav.reports', href: '/reports', icon: FileText, requiredPermission: { resource: 'reports', action: 'read' } },
      { name: 'Analytics', labelKey: 'nav.analytics', href: '/analytics', icon: BarChart3, requiredPermission: { resource: 'reports', action: 'read' } },
      { name: 'Audit Trail', labelKey: 'nav.auditTrail', href: '/audit', icon: FileText, requiredPermission: { resource: 'audit', action: 'read' } },
      { name: 'Event Logs', labelKey: 'nav.eventLogs', href: '/logs', icon: ScrollText, requiredPermission: { resource: 'audit', action: 'read' } },
    ],
  },
  {
    id: 'settings',
    label: 'Settings',
    labelKey: 'nav.sectionSettings',
    icon: Building,
    items: [
      { name: 'Partner', labelKey: 'nav.partner', href: '/settings/partner', icon: Building, partnerScopeOnly: true },
      { name: 'Organizations', labelKey: 'nav.organizations', href: '/settings/organizations', icon: Building2, requiredPermission: { resource: 'organizations', action: 'read' } },
      { name: 'AI Usage & Budget', labelKey: 'nav.aiUsageBudget', href: '/settings/ai-usage', icon: BrainCircuit, partnerScopeOnly: true },
      { name: 'Custom Fields', labelKey: 'nav.customFields', href: '/settings/custom-fields', icon: ListChecks, requiredPermission: { resource: 'organizations', action: 'read' } },
      { name: 'Saved Filters', labelKey: 'nav.savedFilters', href: '/settings/filters', icon: Filter },
      // Users + Roles are both served by the users routes (users:read).
      { name: 'Users', labelKey: 'nav.users', href: '/settings/users', icon: Users, requiredPermission: { resource: 'users', action: 'read' } },
      { name: 'Roles', labelKey: 'nav.roles', href: '/settings/roles', icon: KeyRound, requiredPermission: { resource: 'users', action: 'read' } },
      { name: 'SSO', labelKey: 'nav.sso', href: '/settings/sso', icon: Fingerprint, requiredPermission: { resource: 'sso', action: 'admin' } },
      { name: 'Access Reviews', labelKey: 'nav.accessReviews', href: '/settings/access-reviews', icon: FileCheck, requiredPermission: { resource: 'users', action: 'read' } },
      { name: 'Enrollment Keys', labelKey: 'nav.enrollmentKeys', href: '/settings/enrollment-keys', icon: Key, requiredPermission: { resource: 'devices', action: 'read' } },
      { name: 'Deletion requests', labelKey: 'nav.deletionRequests', href: '/admin/account-deletion-requests', icon: UserX, badgeKind: 'deletion-requests', platformAdminOnly: true },
      { name: 'Quarantined Devices', labelKey: 'nav.quarantinedDevices', href: '/admin/quarantined', icon: Ban, platformAdminOnly: true },
      { name: 'Third-Party Catalog', labelKey: 'nav.thirdPartyCatalog', href: '/admin/third-party-catalog', icon: Boxes, platformAdminOnly: true },
      { name: 'Connected Apps (admin)', labelKey: 'nav.connectedAppsAdmin', href: '/admin/connected-apps', icon: Plug, platformAdminOnly: true },
    ],
  },
];

// Deliberately NOT part of `navSections`: that array is a static module-level
// const (asserted structurally by Sidebar.nav.test.tsx — exact core section
// order/i18n parity), but the runtime-extension "Extensions" section depends
// on an async registry fetch (`useExtensionNavigation`) that can only run
// inside the component. It is built and appended to the render output below
// (see `extensionsSection`), always AFTER the static sections, so a registry
// failure or an empty enabled-navigation list hides only this addition —
// every core section/test stays untouched. `sectionForHref`/`activeHref`
// below are extended to include it so the active-page highlight and
// auto-expand behavior work for extension pages too.

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
// ---------------------------------------------------------------------------
// Badge counts (admin-only nav signals). Returns undefined while loading or
// disabled. Only fetched when `enabled` (= platform admin) — the endpoint
// requires platform-admin access, so firing it for ordinary users 403s on
// every page load and spams the console.
// ---------------------------------------------------------------------------
function useDeletionRequestsBadge(enabled: boolean): number | undefined {
  const [count, setCount] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetchWithAuth('/admin/account-deletion-requests/pending-count')
      .then(async (r) => {
        if (cancelled) return;
        if (!r.ok) {
          // Only platform admins reach here now, so a failure is a genuine
          // error, not the old expected 403 — degrade to no badge but leave a
          // trace.
          console.warn('[sidebar] deletion-requests badge fetch failed', r.status);
          return;
        }
        const data = (await r.json().catch(() => ({}))) as { count?: number };
        if (!cancelled) setCount(typeof data.count === 'number' ? data.count : 0);
      })
      .catch(() => { /* network error — leave badge hidden */ });
    return () => { cancelled = true; };
  }, [enabled]);
  return count;
}

export default function Sidebar({ currentPath: initialPath = '/' }: SidebarProps) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<SidebarMode>(readSavedMode);
  const [hovered, setHovered] = useState(false);
  const currentPath = useCurrentPath(initialPath);
  const navScrollRef = useSidebarScrollPersist();
  const isPlatformAdmin = useAuthStore((s) => s.user?.isPlatformAdmin === true);
  const permissions = useAuthStore((s) => s.user?.permissions);

  // Runtime-extension navigation (see the comment above `navSections`).
  // `useExtensionNavigation` never throws — an empty list here (registry
  // failure, no enabled extension contributes navigation, or none enabled at
  // all) simply omits the whole section below.
  const extensionNavLinks = useExtensionNavigation();
  const extensionsSection: NavSection | null =
    extensionNavLinks.length > 0
      ? {
          id: 'extensions',
          label: 'Extensions',
          labelKey: 'nav.sectionExtensions',
          icon: Puzzle,
          items: extensionNavLinks.map((link) => ({ name: link.name, href: link.href, icon: Puzzle })),
        }
      : null;

  // --- Responsive breakpoints -----------------------------------------------
  // Track whether viewport is below lg (1024px) or md (768px) to override mode
  const [isTablet, setIsTablet] = useState(false);  // < 1024px
  const [isMobile, setIsMobile] = useState(false);   // < 768px
  const { isMobileMenuOpen, closeMobileMenu } = useUiStore();

  const [brandName, setBrandName] = useState<string | null>(null);
  const [brandLogoUrl, setBrandLogoUrl] = useState<string | null>(null);
  const [aiForOfficeEnabled, setAiForOfficeEnabled] = useState(false);

  const [apiVersion, setApiVersion] = useState<string | null>(null);
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchWithAuth('/system/version')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: { version: string; latest: string | null }) => {
        if (cancelled) return;
        setApiVersion(data.version);
        setLatestVersion(data.latest);
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn('[Sidebar] Failed to fetch API version:', err);
        setApiVersion('unavailable');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Fetch partner branding for the top-left header. Skipped when the JWT identifies
  // a non-partner scope; falls through to the server (which will 403) when the scope
  // cannot be decoded.
  useEffect(() => {
    const { scope } = getJwtClaims();
    if (scope !== null && scope !== 'partner') return;

    let cancelled = false;
    fetchWithAuth('/orgs/partners/me')
      .then((r) => {
        if (!r.ok) {
          if (r.status !== 403 && r.status !== 404) {
            console.warn('[Sidebar] Partner branding fetch returned unexpected status', r.status);
          }
          return null;
        }
        return r.json() as Promise<{ name?: string; aiForOfficeEnabled?: boolean; settings?: { branding?: { logoUrl?: string } } }>;
      })
      .then((data) => {
        if (cancelled || !data) return;
        setBrandName(data.name ?? null);
        setBrandLogoUrl(data.settings?.branding?.logoUrl ?? null);
        setAiForOfficeEnabled(data.aiForOfficeEnabled === true);
      })
      .catch((err) => {
        console.warn('[Sidebar] Failed to fetch partner branding:', err);
      });
    return () => { cancelled = true; };
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

  // Find the best matching active href. Includes the runtime-extension items
  // (not part of the static `allNavItems`) so an extension's own page/nav
  // link highlights correctly while it's active.
  const resolvedPath = pathAliases[currentPath] ?? currentPath;
  const activeHref = useMemo(() => {
    let best: string | null = null;
    const candidates = extensionsSection ? [...allNavItems, ...extensionsSection.items] : allNavItems;
    for (const item of candidates) {
      const matches = item.href === '/'
        ? resolvedPath === '/'
        : resolvedPath === item.href || resolvedPath.startsWith(item.href + '/');
      if (matches && (!best || item.href.length > best.length)) {
        best = item.href;
      }
    }
    return best;
  }, [resolvedPath, extensionsSection]);

  // Auto-expand: the section containing the active page should be expanded.
  // Falls back to the extensions section (not covered by the static
  // `sectionForHref`) when the active href belongs to it.
  const activeSectionId = activeHref
    ? (sectionForHref(activeHref)
        ?? (extensionsSection && extensionsSection.items.some((item) => item.href === activeHref)
          ? extensionsSection.id
          : null))
    : null;

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

  // Collapse every section except the one holding the active page, which stays
  // open so the user never loses sight of where they are. Writes an explicit
  // flag for every section so auto-expand can't silently re-open a sibling.
  const collapseAllExceptActive = useCallback(() => {
    const next: Record<string, boolean> = {};
    for (const section of navSections) {
      next[section.id] = section.id === activeSectionId;
    }
    if (extensionsSection) {
      next[extensionsSection.id] = extensionsSection.id === activeSectionId;
    }
    setExpandedSections(next);
    saveExpandedSections(next);
  }, [activeSectionId, extensionsSection]);

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

  const deletionRequestsCount = useDeletionRequestsBadge(isPlatformAdmin);

  // --- Render a single nav item -------------------------------------------
  // Whether a nav item passes all visibility gates (feature flag, platform
  // admin, partner scope, permission). Kept in sync with the early returns in
  // `renderNavItem` below so section-header visibility (renderCollapsibleSection)
  // matches what actually renders — a section whose items are all filtered out
  // must not show an empty header that expands to nothing.
  const isNavItemVisible = (item: NavItem): boolean => {
    if (item.requiresAiForOffice && !aiForOfficeEnabled) return false;
    if (item.platformAdminOnly && !isPlatformAdmin) return false;
    if (item.partnerScopeOnly) {
      const { scope } = getJwtClaims();
      if (scope !== null && scope !== 'partner') return false;
    }
    if (item.requiredPermission) {
      if (!hasPermission(permissions, item.requiredPermission.resource, item.requiredPermission.action)) {
        return false;
      }
    }
    return true;
  };

  const renderNavItem = (item: NavItem, forMobileOverlay = false) => {
    if (!isNavItemVisible(item)) return null;
    const isActive = item.href === activeHref;
    const labels = forMobileOverlay ? true : showLabels;
    const narrow = forMobileOverlay ? false : isNarrow;
    const badgeCount = item.badgeKind === 'deletion-requests' ? deletionRequestsCount : undefined;
    const showBadge = typeof badgeCount === 'number' && badgeCount > 0;
    const label = item.labelKey ? t(/* i18n-dynamic */ item.labelKey, { defaultValue: item.name }) : item.name;
    return (
      <a
        key={item.name}
        href={item.href}
        title={narrow && !hovered ? label : undefined}
        onClick={forMobileOverlay ? () => closeMobileMenu() : undefined}
        className={cn(
          'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
          isActive
            ? 'bg-primary text-primary-foreground'
            : 'text-muted-foreground hover:bg-muted hover:text-foreground'
        )}
      >
        <item.icon className="h-5 w-5 shrink-0" />
        {labels && <span className="truncate flex-1">{label}</span>}
        {labels && showBadge && (
          <span
            className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-500/20 px-1.5 chart-legend-xs font-semibold text-amber-800 dark:bg-amber-500/30 dark:text-amber-200"
            aria-label={`${badgeCount} pending`}
          >
            {badgeCount! > 99 ? '99+' : badgeCount}
          </span>
        )}
      </a>
    );
  };

  // --- Render a collapsible section ----------------------------------------
  const renderCollapsibleSection = (section: NavSection, forMobileOverlay = false) => {
    // Hide the whole section (header + divider) when every item is filtered out
    // by permissions/scope/flags — otherwise a permission-limited user sees an
    // empty group header that expands to nothing (#1629 follow-up).
    if (!section.items.some(isNavItemVisible)) return null;

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
            <span>{section.labelKey ? t(/* i18n-dynamic */ section.labelKey, { defaultValue: section.label }) : section.label}</span>
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
  const toggleTitle = effectiveMode === 'open' ? t('layout.sidebar.autoHide') : effectiveMode === 'hover' ? t('layout.sidebar.collapse') : t('layout.sidebar.expand');

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
        // z-30: app-chrome overlay band. In-page sticky chrome (e.g. the quote/
        // invoice workspace header at z-20) must slide UNDER the popped-out
        // sidebar, not over it; page content < in-page sticky (10–20) <
        // chrome overlays (30–40) < modals/menus (50).
        effectiveMode === 'hover' && 'absolute inset-y-0 left-0 z-30',
        effectiveMode === 'hover' && hovered && 'shadow-xl',
        showLabels ? 'w-64' : 'w-16'
      )}
      onMouseEnter={effectiveMode === 'hover' ? () => setHovered(true) : undefined}
      onMouseLeave={effectiveMode === 'hover' ? () => setHovered(false) : undefined}
    >
      {sectionAnimCss}

      <div className="flex h-16 items-center justify-between border-b px-4">
        <BrandHeader logoUrl={brandLogoUrl} name={brandName} showLabel={showLabels} />
        <div className="flex items-center gap-1">
          {/* Collapse every section except the active one. Only meaningful when
              section labels (and thus expandable groups) are shown. */}
          {showLabels && (
            <button
              onClick={collapseAllExceptActive}
              title={t('layout.sidebar.collapseSections')}
              aria-label={t('layout.sidebar.collapseSections')}
              className="rounded-md p-1.5 hover:bg-muted"
            >
              <ChevronsDownUp className="h-5 w-5" />
            </button>
          )}
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
      </div>

      <nav ref={navScrollRef} data-tour="sidebar-nav" className="sidebar-nav flex-1 min-h-0 space-y-1 overflow-y-auto p-2" style={{ scrollbarGutter: 'stable' }}>
        {topLevelNav.map((item) => renderNavItem(item))}
        {navSections.map((section) => renderCollapsibleSection(section))}
        {extensionsSection && renderCollapsibleSection(extensionsSection)}
      </nav>

      {showLabels && (
        <div className="border-t px-4 py-2 text-[10px] text-muted-foreground/50">
          <p>
            Web <VersionSpan version={WEB_VERSION} latest={latestVersion} component="Web" />
            {apiVersion && apiVersion !== 'unavailable' && (
              <>
                {' · '}API <VersionSpan version={apiVersion} latest={latestVersion} component="API" />
              </>
            )}
            {apiVersion === 'unavailable' && ' · API unavailable'}
          </p>
        </div>
      )}
    </aside>
  );

  // --- Mobile overlay sidebar ----------------------------------------------
  const mobileOverlay = isMobile && isMobileMenuOpen && (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-background/80 backdrop-blur-xs"
        onClick={closeMobileMenu}
      />
      {/* Slide-out sidebar */}
      <aside className="fixed inset-y-0 left-0 z-50 w-64 bg-card border-r shadow-lg overflow-y-auto">
        {sectionAnimCss}

        <div className="flex h-16 items-center justify-between border-b px-4">
          <BrandHeader logoUrl={brandLogoUrl} name={brandName} showLabel />
          <div className="flex items-center gap-1">
            <button
              onClick={collapseAllExceptActive}
              title={t('layout.sidebar.collapseSections')}
              aria-label={t('layout.sidebar.collapseSections')}
              className="rounded-md p-1.5 hover:bg-muted"
            >
              <ChevronsDownUp className="h-5 w-5" />
            </button>
            <button
              onClick={closeMobileMenu}
              className="rounded-md p-1.5 hover:bg-muted"
              title={t('layout.sidebar.closeMenu')}
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        <nav className="sidebar-nav flex-1 min-h-0 space-y-1 overflow-y-auto p-2">
          {topLevelNav.map((item) => renderNavItem(item, true))}
          {navSections.map((section) => renderCollapsibleSection(section, true))}
          {extensionsSection && renderCollapsibleSection(extensionsSection, true)}
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
      <div className="relative w-16 shrink-0">
        {sidebarContent}
      </div>
    );
  }

  return sidebarContent;
}

export function VersionSpan({
  version,
  latest,
  component,
}: {
  version: string;
  latest: string | null;
  component: 'Web' | 'API';
}) {
  if (!latest) {
    return <span title={`${component} ${version} — latest version unknown`}>{version}</span>;
  }
  const cmp = semverCompare(version, latest);
  if (cmp === null) {
    return <span title={`${component} ${version} — latest version unknown`}>{version}</span>;
  }
  if (cmp < 0) {
    return (
      <span
        className="text-red-500/80"
        title={`${component} ${version} — update available (latest ${latest})`}
      >
        {version}
      </span>
    );
  }
  return (
    <span
      className="text-green-500/70"
      title={`${component} ${version} — up to date`}
    >
      {version}
    </span>
  );
}
