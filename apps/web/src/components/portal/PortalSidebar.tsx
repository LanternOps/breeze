import { useState } from 'react';
import {
  LayoutDashboard,
  Monitor,
  LifeBuoy,
  Ticket,
  Package,
  ChevronLeft,
  ChevronRight
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

type PortalNavItem = {
  name: string;
  href: string;
  icon: typeof LayoutDashboard;
};

type PortalSidebarProps = {
  items?: PortalNavItem[];
  currentPath?: string;
  className?: string;
};

const defaultItems: PortalNavItem[] = [
  { name: 'Overview', href: '/portal', icon: LayoutDashboard },
  { name: 'My Devices', href: '/portal/devices', icon: Monitor },
  { name: 'Support Tickets', href: '/portal/tickets', icon: Ticket },
  { name: 'Asset Checkout', href: '/portal/assets', icon: Package },
  { name: 'Help Center', href: '/portal/help', icon: LifeBuoy }
];

const defaultLabelKeys: Record<string, string> = {
  '/portal': 'sidebar.items.overview',
  '/portal/devices': 'sidebar.items.myDevices',
  '/portal/tickets': 'sidebar.items.supportTickets',
  '/portal/assets': 'sidebar.items.assetCheckout',
  '/portal/help': 'sidebar.items.helpCenter'
};

export default function PortalSidebar({
  items,
  currentPath = '/',
  className
}: PortalSidebarProps) {
  const { t } = useTranslation('portal');
  const [collapsed, setCollapsed] = useState(false);
  const resolvedPath = currentPath;
  const navItems = items ?? defaultItems;

  return (
    <aside
      className={cn(
        'flex h-full flex-col border-r bg-card transition-all duration-200',
        collapsed ? 'w-16' : 'w-64',
        className
      )}
    >
      <div className="flex h-16 items-center justify-between border-b px-4">
        {!collapsed && (
          <span className="text-sm font-semibold text-muted-foreground">
            {t('sidebar.navigation')}
          </span>
        )}
        <button
          type="button"
          onClick={() => setCollapsed(!collapsed)}
          aria-label={collapsed ? t('sidebar.expand') : t('sidebar.collapse')}
          className="rounded-md p-1.5 hover:bg-muted"
        >
          {collapsed ? (
            <ChevronRight className="h-5 w-5" />
          ) : (
            <ChevronLeft className="h-5 w-5" />
          )}
        </button>
      </div>

      <nav className="flex-1 space-y-1 p-2">
        {navItems.map(item => {
          const label = items ? item.name : t(defaultLabelKeys[item.href]); // i18n-dynamic
          const isActive =
            item.href === '/portal'
              ? resolvedPath === '/portal'
              : resolvedPath.startsWith(item.href);
          return (
            <a
              key={item.href}
              href={item.href}
              className={cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                isActive
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              )}
            >
              <item.icon className="h-5 w-5 shrink-0" />
              {!collapsed && <span>{label}</span>}
            </a>
          );
        })}
      </nav>
    </aside>
  );
}
