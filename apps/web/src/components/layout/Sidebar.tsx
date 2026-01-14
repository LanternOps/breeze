import { useState } from 'react';
import {
  LayoutDashboard,
  Monitor,
  FileCode,
  Zap,
  Bell,
  Terminal,
  FileText,
  Settings,
  Building,
  Building2,
  Users,
  ChevronLeft,
  ChevronRight,
  Shield,
  ShieldCheck,
  KeyRound,
  Package,
  Webhook,
  Plug,
  Network,
  HardDrive,
  BarChart3
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface SidebarProps {
  currentPath?: string;
}

const navigation = [
  { name: 'Dashboard', href: '/', icon: LayoutDashboard },
  { name: 'Devices', href: '/devices', icon: Monitor },
  { name: 'Discovery', href: '/discovery', icon: Network },
  { name: 'Scripts', href: '/scripts', icon: FileCode },
  { name: 'Automations', href: '/automations', icon: Zap },
  { name: 'Policies', href: '/policies', icon: Shield },
  { name: 'Patches', href: '/patches', icon: Package },
  { name: 'Alerts', href: '/alerts', icon: Bell },
  { name: 'Reports', href: '/reports', icon: FileText },
  { name: 'Analytics', href: '/analytics', icon: BarChart3 },
  { name: 'Remote Access', href: '/remote', icon: Terminal }
];

const integrationsNav = [
  { name: 'Webhooks', href: '/integrations/webhooks', icon: Webhook },
  { name: 'PSA Connections', href: '/integrations/psa', icon: Plug }
];

const monitoringNav = [
  { name: 'Security', href: '/security', icon: ShieldCheck },
  { name: 'Network/SNMP', href: '/snmp', icon: Network }
];

const operationsNav = [
  { name: 'Backup', href: '/backup', icon: HardDrive },
  { name: 'Audit Logs', href: '/audit', icon: FileText }
];

const managementNav = [
  { name: 'Software', href: '/software', icon: Package },
  { name: 'Policies', href: '/policies', icon: Shield },
  { name: 'Organizations', href: '/organizations', icon: Building2 },
  { name: 'Users', href: '/users', icon: Users },
  { name: 'Roles', href: '/settings/roles', icon: KeyRound },
  { name: 'Settings', href: '/settings', icon: Settings }
];

const settingsNav = [
  { name: 'Organization', href: '/settings/organization', icon: Building },
  { name: 'Integrations', href: '/integrations', icon: Plug }
];

export default function Sidebar({ currentPath: initialPath = '/' }: SidebarProps) {
  const [collapsed, setCollapsed] = useState(false);
  const currentPath = initialPath;

  return (
    <aside
      className={cn(
        'flex h-full flex-col border-r bg-card transition-all duration-300',
        collapsed ? 'w-16' : 'w-64'
      )}
    >
      <div className="flex h-16 items-center justify-between border-b px-4">
        {!collapsed && (
          <span className="text-xl font-bold text-primary">Breeze</span>
        )}
        <button
          onClick={() => setCollapsed(!collapsed)}
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
        {navigation.map((item) => {
          const isActive = item.href === '/'
            ? currentPath === '/'
            : currentPath.startsWith(item.href);
          return (
            <a
              key={item.name}
              href={item.href}
              className={cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                isActive
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              )}
            >
              <item.icon className="h-5 w-5 flex-shrink-0" />
              {!collapsed && <span>{item.name}</span>}
            </a>
          );
        })}

        <div className="my-4 border-t" />

        {!collapsed && (
          <span className="px-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Monitoring
          </span>
        )}
        {monitoringNav.map((item) => {
          const isActive = currentPath.startsWith(item.href);
          return (
            <a
              key={item.name}
              href={item.href}
              className={cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                isActive
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              )}
            >
              <item.icon className="h-5 w-5 flex-shrink-0" />
              {!collapsed && <span>{item.name}</span>}
            </a>
          );
        })}

        <div className="my-4 border-t" />

        {!collapsed && (
          <span className="px-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Operations
          </span>
        )}
        {operationsNav.map((item) => {
          const isActive = currentPath.startsWith(item.href);
          return (
            <a
              key={item.name}
              href={item.href}
              className={cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                isActive
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              )}
            >
              <item.icon className="h-5 w-5 flex-shrink-0" />
              {!collapsed && <span>{item.name}</span>}
            </a>
          );
        })}

        <div className="my-4 border-t" />

        {!collapsed && (
          <span className="px-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Integrations
          </span>
        )}
        {integrationsNav.map((item) => {
          const isActive = currentPath.startsWith(item.href);
          return (
            <a
              key={item.name}
              href={item.href}
              className={cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                isActive
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              )}
            >
              <item.icon className="h-5 w-5 flex-shrink-0" />
              {!collapsed && <span>{item.name}</span>}
            </a>
          );
        })}

        <div className="my-4 border-t" />

        {!collapsed && (
          <span className="px-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Management
          </span>
        )}
        {managementNav.map((item) => {
          const isActive = currentPath.startsWith(item.href);
          return (
            <a
              key={item.name}
              href={item.href}
              className={cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                isActive
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              )}
            >
              <item.icon className="h-5 w-5 flex-shrink-0" />
              {!collapsed && <span>{item.name}</span>}
            </a>
          );
        })}

        <div className="my-4 border-t" />

        {!collapsed && (
          <span className="px-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Settings
          </span>
        )}
        {settingsNav.map((item) => {
          const isActive = currentPath.startsWith(item.href);
          return (
            <a
              key={item.name}
              href={item.href}
              className={cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                isActive
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              )}
            >
              <item.icon className="h-5 w-5 flex-shrink-0" />
              {!collapsed && <span>{item.name}</span>}
            </a>
          );
        })}
      </nav>
    </aside>
  );
}
