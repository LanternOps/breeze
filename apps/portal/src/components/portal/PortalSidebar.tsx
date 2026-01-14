import React, { useState } from 'react';
import {
  Monitor,
  Ticket,
  Package,
  User,
  Menu,
  X,
  HelpCircle
} from 'lucide-react';
import { useBranding } from './BrandingProvider';
import { cn } from '@/lib/utils';

interface NavItem {
  name: string;
  href: string;
  icon: React.ElementType;
}

const navigation: NavItem[] = [
  { name: 'Devices', href: '/devices', icon: Monitor },
  { name: 'Tickets', href: '/tickets', icon: Ticket },
  { name: 'Assets', href: '/assets', icon: Package },
  { name: 'Profile', href: '/profile', icon: User }
];

export function PortalSidebar() {
  const { branding } = useBranding();
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  // Get current path for active state
  const currentPath = typeof window !== 'undefined' ? window.location.pathname : '';

  const isActive = (href: string) => {
    if (href === '/') return currentPath === '/';
    return currentPath.startsWith(href);
  };

  const NavLinks = () => (
    <>
      {navigation.map((item) => {
        const Icon = item.icon;
        const active = isActive(item.href);

        return (
          <a
            key={item.name}
            href={item.href}
            className={cn(
              'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
              active
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
            )}
          >
            <Icon className="h-5 w-5" />
            {item.name}
          </a>
        );
      })}
    </>
  );

  return (
    <>
      {/* Mobile menu button */}
      <button
        onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
        className="fixed left-4 top-4 z-50 rounded-md bg-card p-2 shadow-md lg:hidden"
        aria-label="Toggle menu"
      >
        {isMobileMenuOpen ? (
          <X className="h-6 w-6" />
        ) : (
          <Menu className="h-6 w-6" />
        )}
      </button>

      {/* Mobile overlay */}
      {isMobileMenuOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/50 lg:hidden"
          onClick={() => setIsMobileMenuOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-40 w-64 transform border-r bg-card transition-transform lg:static lg:translate-x-0',
          isMobileMenuOpen ? 'translate-x-0' : '-translate-x-full'
        )}
      >
        <div className="flex h-full flex-col">
          {/* Logo */}
          <div className="flex h-16 items-center border-b px-6">
            {branding.logoUrl ? (
              <img
                src={branding.logoUrl}
                alt={branding.name}
                className="h-8 w-auto"
              />
            ) : (
              <div className="flex items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary">
                  <Monitor className="h-5 w-5 text-primary-foreground" />
                </div>
                <span className="font-semibold">{branding.name}</span>
              </div>
            )}
          </div>

          {/* Navigation */}
          <nav className="flex-1 space-y-1 p-4">
            <NavLinks />
          </nav>

          {/* Support section */}
          <div className="border-t p-4">
            <div className="rounded-md bg-muted p-4">
              <div className="flex items-center gap-2 text-sm font-medium">
                <HelpCircle className="h-4 w-4" />
                Need Help?
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Contact our support team for assistance.
              </p>
              {branding.supportEmail && (
                <a
                  href={`mailto:${branding.supportEmail}`}
                  className="mt-2 block text-xs text-primary hover:underline"
                >
                  {branding.supportEmail}
                </a>
              )}
              {branding.supportPhone && (
                <a
                  href={`tel:${branding.supportPhone}`}
                  className="mt-1 block text-xs text-primary hover:underline"
                >
                  {branding.supportPhone}
                </a>
              )}
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}

export default PortalSidebar;
