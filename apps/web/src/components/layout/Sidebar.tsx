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
  Building2,
  Users,
  ChevronLeft,
  ChevronRight,
  Shield
} from 'lucide-react';
import { cn } from '@/lib/utils';

const navigation = [
  { name: 'Dashboard', href: '/', icon: LayoutDashboard },
  { name: 'Devices', href: '/devices', icon: Monitor },
  { name: 'Scripts', href: '/scripts', icon: FileCode },
  { name: 'Automations', href: '/automations', icon: Zap },
  { name: 'Policies', href: '/policies', icon: Shield },
  { name: 'Alerts', href: '/alerts', icon: Bell },
  { name: 'Reports', href: '/reports', icon: FileText },
  { name: 'Remote Access', href: '/remote', icon: Terminal }
];

const managementNav = [
  { name: 'Organizations', href: '/organizations', icon: Building2 },
  { name: 'Users', href: '/users', icon: Users },
  { name: 'Settings', href: '/settings', icon: Settings }
];

export default function Sidebar() {
  const [collapsed, setCollapsed] = useState(false);
  const currentPath = typeof window !== 'undefined' ? window.location.pathname : '/';

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
      </nav>
    </aside>
  );
}
